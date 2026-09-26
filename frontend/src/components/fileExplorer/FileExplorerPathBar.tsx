// The bar under the tab strip: '↑', the current root, the tree/list toggle,
// re-read and new folder, in the order PATH_BAR_CONTROLS gives (design §9.2).
//
// '↑' is enabled by canGoUp alone — whether the server listed a '..' — and a
// refused listing is reported here, never corrected: the root stays where it
// was and the server's message is shown (SEC-FOP-001 AC-5).
import { IconButton } from '../common';
import type { UseFileTreeResult } from '../../hooks/useFileTree.ts';
import type { FileTreeMode } from './fileTreeState.ts';
import { canGoUp } from './fileTreeState.ts';
import { PATH_BAR_CONTROLS } from './fileExplorerPathBarModel.ts';

export interface FileExplorerPathBarProps {
  tree: UseFileTreeResult;
  setMode: (mode: FileTreeMode) => void;
  /** Absent until folder creation is wired; the button is then shown disabled. */
  onNewDirectory?: () => void;
}

// @req FR-FEX-002
// @req SEC-FOP-001
export function FileExplorerPathBar({ tree, setMode, onNewDirectory }: FileExplorerPathBarProps) {
  const { state } = tree;
  const nextMode: FileTreeMode = state.mode === 'tree' ? 'list' : 'tree';

  return (
    <div className="fx-pathbar-wrap">
      <div className="fx-pathbar">
        {PATH_BAR_CONTROLS.map((control) => {
          switch (control) {
            case 'up':
              // The shared set has no upward glyph, so the downward chevron is
              // drawn turned over (.fx-up-button in FileExplorer.css).
              return (
                <IconButton
                  key={control}
                  icon="chevron-down"
                  className="fx-bar-button fx-up-button"
                  label="상위 폴더"
                  disabled={!canGoUp(state) || state.pendingRoot !== null}
                  onClick={() => void tree.goUp()}
                />
              );
            case 'path':
              return (
                <span key={control} className="fx-path" title={state.root}>
                  {state.root}
                </span>
              );
            case 'mode':
              // The drawing is the view the button switches to: rules for the
              // list, a folder for the tree.
              return (
                <IconButton
                  key={control}
                  icon={nextMode === 'list' ? 'menu' : 'folder'}
                  className="fx-bar-button fx-mode-toggle"
                  label={nextMode === 'list' ? '목록으로 보기' : '트리로 보기'}
                  onClick={() => setMode(nextMode)}
                />
              );
            case 'refresh':
              return (
                <IconButton
                  key={control}
                  icon="refresh"
                  className="fx-bar-button"
                  label="새로 읽기"
                  onClick={() => void tree.refresh(state.root)}
                />
              );
            case 'newdir':
              return (
                <IconButton
                  key={control}
                  icon="plus"
                  className="fx-bar-button"
                  label="새 폴더"
                  disabled={onNewDirectory === undefined}
                  onClick={onNewDirectory}
                />
              );
          }
        })}
      </div>
      {state.error !== null && (
        <div role="alert" className="fx-pathbar-error">
          {state.error}
        </div>
      )}
    </div>
  );
}
