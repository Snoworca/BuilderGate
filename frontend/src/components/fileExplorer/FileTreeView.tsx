// The explorer's tree mode: every visible node, drawn in the order
// selectVisibleRows gives, with no row cap and no windowing (FR-FEX-002 AC-8) —
// scroll restore finds its anchor by name, so every row has to be in the DOM.
//
// Every decision is made elsewhere: selection in decideRowPointer, the expander
// in decideRowClick, double click in decideDoubleClick, dimming in
// rowRenderClass. This component only turns events into their inputs.
import type { MouseEvent } from 'react';
import type { UseFileTreeResult } from '../../hooks/useFileTree.ts';
import {
  decideDoubleClick,
  decideRowClick,
  decideRowPointer,
  rowRenderClass,
  type ExplorerClipboard,
  type NodeRow,
} from './fileRowInteraction.ts';
import { canGoUp, selectVisibleRows } from './fileTreeState.ts';

export interface FileTreeViewProps {
  tree: UseFileTreeResult;
  clipboard?: ExplorerClipboard | null;
  /** A double click on an openable file. Opening is the editor's, never the explorer's. */
  onOpenFile: (filePath: string) => void;
}

// @req FR-FEX-002
// @req FR-FEX-011
export function FileTreeView({ tree, clipboard = null, onOpenFile }: FileTreeViewProps) {
  const rows = selectVisibleRows(tree.state);
  // Shift-range selection walks exactly the rows drawn here, in this order.
  const nodePaths = rows.flatMap((row) => (row.kind === 'node' ? [row.path] : []));

  const toggle = (path: string) => {
    if (tree.state.expandedPaths.has(path)) tree.collapse(path);
    else void tree.expand(path);
  };

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

  // The expander only toggles; it must not also select the row it sits on.
  const handleExpanderClick = (event: MouseEvent<HTMLSpanElement>, row: NodeRow) => {
    event.stopPropagation();
    const decision = decideRowClick({
      targetPart: 'expander',
      mode: tree.state.mode,
      isDir: row.type === 'directory',
      mods: { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey },
    });
    if (decision.type === 'toggle-expand') toggle(row.path);
  };

  // One delegated handler for the whole list, because '..' is not a node and has
  // no NodeRow to decide on; every other row goes through decideDoubleClick.
  const handleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest('[data-up]') !== null) {
      void tree.goUp();
      return;
    }
    const path = target.closest('[data-path]')?.getAttribute('data-path');
    const row = rows.find((candidate): candidate is NodeRow => candidate.kind === 'node' && candidate.path === path);
    if (row === undefined) return;
    const decision = decideDoubleClick(row, tree.state.mode);
    if (decision.type === 'open-editor') onOpenFile(decision.path);
    else if (decision.type === 'toggle-expand') toggle(decision.path);
    else if (decision.type === 'enter') void tree.setRoot(decision.path);
  };

  return (
    <div className="fx-rows" role="tree" onDoubleClick={handleDoubleClick}>
      {canGoUp(tree.state) && (
        <div className="fx-row fx-up-row" data-up="true">
          <span className="fx-expander fx-leaf" />
          <span className="fx-name">..</span>
        </div>
      )}
      {rows.map((row) => {
        // '..' is drawn above, outside the node list, and never as a node.
        if (row.kind !== 'node') return null;
        const isDir = row.type === 'directory';
        const expanded = isDir && tree.state.expandedPaths.has(row.path);
        const child = tree.state.childrenByPath.get(row.path);
        return (
          <div
            key={row.path}
            className={`fx-row ${isDir ? 'fx-dir' : 'fx-file'} ${rowRenderClass(row, clipboard)}`}
            role="treeitem"
            aria-selected={tree.state.selectedPaths.has(row.path)}
            aria-expanded={isDir ? expanded : undefined}
            data-path={row.path}
            data-name={row.name}
            data-depth={row.depth}
            style={{ paddingLeft: `calc(${row.depth} * 16px + 4px)` }}
            onClick={(event) => handleRowClick(event, row)}
          >
            <span
              className={`fx-expander${isDir ? '' : ' fx-leaf'}${expanded ? ' fx-open' : ''}`}
              onClick={(event) => handleExpanderClick(event, row)}
            >
              {isDir ? '›' : ''}
            </span>
            <span className="fx-icon">{isDir ? '▸' : '·'}</span>
            <span className="fx-name">{row.name}</span>
            {child?.status === 'loading' && <span className="fx-meta">…</span>}
            {child?.status === 'error' && <span className="fx-meta fx-error-text">{child.error}</span>}
          </div>
        );
      })}
    </div>
  );
}
