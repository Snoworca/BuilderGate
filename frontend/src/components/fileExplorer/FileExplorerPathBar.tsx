// The bar under the tab strip: '↑', the current root, the tree/list toggle,
// re-read and new folder, in the order PATH_BAR_CONTROLS gives (design §9.2).
//
// '↑' is enabled by canGoUp alone — whether the server listed a '..' — and a
// refused listing is reported here, never corrected: the root stays where it
// was and the server's message is shown (SEC-FOP-001 AC-5).
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
              return (
                <button
                  key={control}
                  type="button"
                  className="fx-bar-button"
                  aria-label="상위 폴더"
                  title="상위 폴더"
                  disabled={!canGoUp(state) || state.pendingRoot !== null}
                  onClick={() => void tree.goUp()}
                >
                  ↑
                </button>
              );
            case 'path':
              return (
                <span key={control} className="fx-path" title={state.root}>
                  {state.root}
                </span>
              );
            case 'mode':
              return (
                <button
                  key={control}
                  type="button"
                  className="fx-bar-button fx-mode-toggle"
                  aria-label={nextMode === 'list' ? '목록으로 보기' : '트리로 보기'}
                  title={nextMode === 'list' ? '목록으로 보기' : '트리로 보기'}
                  onClick={() => setMode(nextMode)}
                >
                  {nextMode === 'list' ? '☰' : '⊢'}
                </button>
              );
            case 'refresh':
              return (
                <button
                  key={control}
                  type="button"
                  className="fx-bar-button"
                  aria-label="새로 읽기"
                  title="새로 읽기"
                  onClick={() => void tree.refresh(state.root)}
                >
                  ⟳
                </button>
              );
            case 'newdir':
              return (
                <button
                  key={control}
                  type="button"
                  className="fx-bar-button"
                  aria-label="새 폴더"
                  title="새 폴더"
                  disabled={onNewDirectory === undefined}
                  onClick={onNewDirectory}
                >
                  +
                </button>
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
