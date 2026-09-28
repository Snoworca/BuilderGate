// FR-FEX-013: the search row and its results. It replaces the path bar and the rows while
// open. The server walks the tree; this only starts, polls, cancels and draws.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { t, tn } from '../../i18n/i18n.ts';
import { fileSearchApi } from '../../services/api.ts';
import { IconButton } from '../common';
import { HighlightedName } from './HighlightedName.tsx';
import { EMPTY_SEARCH_VIEW, createFileSearchController, type FileSearchResult, type FileSearchView } from './fileSearchController.ts';

export interface FileExplorerSearchProps {
  sessionId: string;
  /** The directory to search under. */
  root: string;
  onClose: () => void;
  onOpenDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
}

const TYPING_DELAY_MS = 350;

export function FileExplorerSearch({ sessionId, root, onClose, onOpenDirectory, onOpenFile }: FileExplorerSearchProps) {
  const [query, setQuery] = useState('');
  const [includeIgnored, setIncludeIgnored] = useState(false);
  const [view, setView] = useState<FileSearchView>(EMPTY_SEARCH_VIEW);
  const inputRef = useRef<HTMLInputElement>(null);
  const controller = useMemo(
    () => createFileSearchController({ sessionId, api: fileSearchApi, onChange: setView }),
    [sessionId],
  );

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => () => void controller.close(), [controller]);

  // A pause in typing starts the search; Enter starts it at once.
  useEffect(() => {
    if (query.trim() === '') {
      void controller.close();
      return undefined;
    }
    const handle = window.setTimeout(() => void controller.start({ path: root, query: query.trim(), includeIgnored }), TYPING_DELAY_MS);
    return () => window.clearTimeout(handle);
  }, [controller, query, includeIgnored, root]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The explorer's own keys (type-to-filter, Delete, Ctrl+C) must not act behind the search.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      if (view.running) void controller.cancel();
      else onClose();
    } else if (event.key === 'Enter' && event.target === inputRef.current && query.trim() !== '') {
      event.preventDefault();
      void controller.start({ path: root, query: query.trim(), includeIgnored });
    }
  };

  const open = (result: FileSearchResult) => {
    void controller.close();
    if (result.type === 'directory') onOpenDirectory(result.path);
    else onOpenFile(result.path);
  };

  const status = view.outcome === null
    ? null
    : view.running
      ? t('fileExplorer.search.running', { examined: view.examined.toLocaleString(), found: view.results.length.toLocaleString() })
      : view.outcome === 'cancelled'
        ? t('fileExplorer.search.cancelled', { found: view.results.length.toLocaleString() })
        : view.outcome === 'truncated'
          ? t('fileExplorer.search.truncated', { found: view.results.length.toLocaleString() })
          : view.outcome === 'failed'
            ? t('fileExplorer.search.failed', { message: view.error ?? '' })
            : tn('fileExplorer.search.done', view.results.length, { examined: view.examined.toLocaleString() });

  return (
    <div className="fx-search" onKeyDown={handleKeyDown}>
      <div className="fx-pathbar fx-search-bar">
        <input
          ref={inputRef}
          className="fx-search-input"
          type="search"
          value={query}
          placeholder={t('fileExplorer.search.placeholder')}
          aria-label={t('fileExplorer.search.placeholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
        <label className="fx-search-toggle" title={t('fileExplorer.search.includeIgnoredHint')}>
          <input type="checkbox" checked={includeIgnored} onChange={(event) => setIncludeIgnored(event.target.checked)} />
          {t('fileExplorer.search.includeIgnored')}
        </label>
        {view.running && (
          <button type="button" className="fx-confirm-button fx-danger" onClick={() => void controller.cancel()}>
            {t('common.cancel')}
          </button>
        )}
        <IconButton icon="close" className="fx-bar-button" label={t('fileExplorer.search.close')} onClick={onClose} />
      </div>
      {status !== null && (
        <div className="fx-search-status" role="status">
          <span>{status}</span>
          {view.running && <span className="fx-search-track" aria-hidden="true"><i /></span>}
        </div>
      )}
      {view.running && view.currentPath !== '' && <div className="fx-search-current" title={view.currentPath}>{view.currentPath}</div>}
      <div className="fx-scroll fx-search-results" role="list">
        {view.results.map((result) => (
          <button key={result.path} type="button" role="listitem" className={`fx-row fx-search-row ${result.type === 'directory' ? 'fx-dir' : 'fx-file'}`} title={result.path} onClick={() => open(result)}>
            <span className="fx-name"><HighlightedName name={result.name} text={view.query} /></span>
            <span className="fx-meta fx-search-rel">{result.relativePath}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
