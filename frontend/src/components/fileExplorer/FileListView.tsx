// The explorer's list mode: the root's direct children in three columns, every
// one of them in the DOM (FR-FEX-002 AC-8). The column set and the sort rule
// live in fileListView.ts; the row decisions in fileRowInteraction.ts.
import type { MouseEvent } from 'react';
import type { UseFileTreeResult } from '../../hooks/useFileTree.ts';
import type { DirectoryEntry } from '../../types/index.ts';
import {
  decideDoubleClick,
  decideRowPointer,
  rowRenderClass,
  type ExplorerClipboard,
  type NodeRow,
} from './fileRowInteraction.ts';
import { LIST_COLUMNS, selectListRows, type ListColumn, type ListSort } from './fileListView.ts';
import { canGoUp, selectVisibleRows } from './fileTreeState.ts';

export interface FileListViewProps {
  tree: UseFileTreeResult;
  sort: ListSort | null;
  onSortChange: (sort: ListSort) => void;
  clipboard?: ExplorerClipboard | null;
  /** A double click on an openable file. Opening is the editor's, never the explorer's. */
  onOpenFile: (filePath: string) => void;
}

const COLUMN_LABELS: Record<ListColumn, string> = {
  name: '이름',
  modified: '수정한 날짜',
  size: '크기',
};

// Same column again flips the direction; another column starts ascending.
function nextSort(current: ListSort | null, key: ListColumn): ListSort {
  if (current !== null && current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: 'asc' };
}

function formatSize(entry: DirectoryEntry): string {
  if (entry.type === 'directory') return '';
  if (entry.size < 1024) return `${entry.size} B`;
  if (entry.size < 1024 * 1024) return `${(entry.size / 1024).toFixed(1)} KB`;
  return `${(entry.size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatModified(modified: string): string {
  const date = new Date(modified);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

// @req FR-FEX-002
// @req FR-FEX-011
export function FileListView({ tree, sort, onSortChange, clipboard = null, onOpenFile }: FileListViewProps) {
  const listRows = selectListRows(tree.state, sort);
  // Paths come from the tree's own rows, so a list row names the same path the
  // reducer checks a selection against.
  const pathByName = new Map(selectVisibleRows(tree.state).flatMap((row) => (row.kind === 'node' ? [[row.name, row.path] as const] : [])));
  const nodeOf = (entry: DirectoryEntry): NodeRow => ({
    kind: 'node',
    path: pathByName.get(entry.name) ?? entry.name,
    name: entry.name,
    type: entry.type,
    depth: 0,
  });
  // Shift-range selection walks exactly the rows drawn here, in this order.
  const nodePaths = listRows.map((entry) => nodeOf(entry).path);

  const handleRowClick = (event: MouseEvent<HTMLDivElement>, row: NodeRow) => {
    const decision = decideRowPointer({
      button: event.button,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isSelected: tree.state.selectedPaths.has(row.path),
    });
    if (decision.type !== 'select') return;
    tree.dispatch({ type: 'CLICK_ROW', path: row.path, mods: decision.mods, orderedPaths: nodePaths });
  };

  // One delegated handler, because '..' is not a node and has no NodeRow to
  // decide on; every other row goes through decideDoubleClick.
  const handleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest('[data-up]') !== null) {
      void tree.goUp();
      return;
    }
    const path = target.closest('[data-path]')?.getAttribute('data-path');
    const entry = listRows.find((candidate) => nodeOf(candidate).path === path);
    if (entry === undefined) return;
    const decision = decideDoubleClick(nodeOf(entry), tree.state.mode);
    if (decision.type === 'open-editor') onOpenFile(decision.path);
    else if (decision.type === 'enter') void tree.setRoot(decision.path);
  };

  return (
    <div className="fx-list" role="grid">
      <div className="fx-list-header" role="row">
        {LIST_COLUMNS.map((column) => (
          <button
            key={column}
            type="button"
            className={`fx-list-head fx-col-${column}`}
            role="columnheader"
            aria-sort={sort?.key === column ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
            onClick={() => onSortChange(nextSort(sort, column))}
          >
            {COLUMN_LABELS[column]}
            {sort?.key === column ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
          </button>
        ))}
      </div>
      <div className="fx-rows" onDoubleClick={handleDoubleClick}>
        {canGoUp(tree.state) && (
          <div className="fx-row fx-up-row" data-up="true" role="row">
            <span className="fx-name fx-col-name">..</span>
          </div>
        )}
        {listRows.map((entry) => {
          const row = nodeOf(entry);
          return (
            <div
              key={row.path}
              className={`fx-row fx-list-row ${entry.type === 'directory' ? 'fx-dir' : 'fx-file'} ${rowRenderClass(row, clipboard)}`}
              role="row"
              aria-selected={tree.state.selectedPaths.has(row.path)}
              data-path={row.path}
              data-name={row.name}
              data-depth={0}
              onClick={(event) => handleRowClick(event, row)}
            >
              <span className="fx-name fx-col-name">
                <span className="fx-icon">{entry.type === 'directory' ? '▸' : '·'}</span>
                {entry.name}
              </span>
              <span className="fx-meta fx-col-modified">{formatModified(entry.modified)}</span>
              <span className="fx-meta fx-col-size">{formatSize(entry)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
