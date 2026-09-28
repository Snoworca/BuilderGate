// The bar under the tab strip: '↑', the current root, the tree/list toggle,
// re-read and new folder, in the order PATH_BAR_CONTROLS gives (design §9.2).
//
// '↑' is enabled by canGoUp alone — whether the server listed a '..' — and a
// refused listing is reported here, never corrected: the root stays where it
// was and the server's message is shown (SEC-FOP-001 AC-5).
import { t } from '../../i18n/i18n.ts';
import { IconButton } from '../common';
import type { UseFileTreeResult } from '../../hooks/useFileTree.ts';
import type { FileTreeMode } from './fileTreeState.ts';
import { canGoUp } from './fileTreeState.ts';
import { PATH_BAR_CONTROLS, buildBreadcrumb, collapseBreadcrumb } from './fileExplorerPathBarModel.ts';

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
              // FR-FEX-017 AC-2: at the session root there is nowhere to go, so no button.
              if (!canGoUp(state)) return null;
              // The shared set has no upward glyph, so the downward chevron is
              // drawn turned over (.fx-up-button in FileExplorer.css).
              return (
                <IconButton
                  key={control}
                  icon="chevron-down"
                  className="fx-bar-button fx-up-button"
                  label={t('fileExplorer.path.parent')}
                  disabled={state.pendingRoot !== null}
                  onClick={() => void tree.goUp()}
                />
              );
            case 'path': {
              // FR-FEX-016: list mode shows ./a/b/c from the session root, each segment clickable.
              const crumbs = state.mode === 'list' ? buildBreadcrumb(state.root, state.sessionRoot ?? null) : null;
              if (crumbs === null) {
                return (
                  <span key={control} className="fx-path" title={state.root}>
                    {state.root}
                  </span>
                );
              }
              return (
                <nav key={control} className="fx-path fx-crumbs" title={state.root} aria-label={t('fileExplorer.path.breadcrumb')}>
                  {collapseBreadcrumb(crumbs).map((item, index) => (
                    <span key={index} className="fx-crumb-item">
                      {index > 0 && <span className="fx-crumb-sep" aria-hidden="true">/</span>}
                      {item.kind === 'ellipsis' ? (
                        <span className="fx-crumb-ellipsis" title={item.title}>…</span>
                      ) : (
                        <button
                          type="button"
                          className={`fx-crumb${item.action === 'refresh' ? ' fx-crumb-current' : ''}`}
                          title={item.action === 'refresh' ? t('fileExplorer.path.reload') : item.path}
                          onClick={() => void (item.action === 'refresh' ? tree.refresh(state.root) : tree.setRoot(item.path))}
                        >
                          {item.label}
                        </button>
                      )}
                      {item.kind === 'root' && crumbs.length === 1 && <span className="fx-crumb-sep" aria-hidden="true">/</span>}
                    </span>
                  ))}
                </nav>
              );
            }
            case 'mode':
              // The drawing is the view the button switches to: rules for the
              // list, a folder for the tree.
              return (
                <IconButton
                  key={control}
                  icon={nextMode === 'list' ? 'menu' : 'folder'}
                  className="fx-bar-button fx-mode-toggle"
                  label={nextMode === 'list' ? t('fileExplorer.path.asList') : t('fileExplorer.path.asTree')}
                  onClick={() => setMode(nextMode)}
                />
              );
            case 'refresh':
              return (
                <IconButton
                  key={control}
                  icon="refresh"
                  className="fx-bar-button"
                  label={t('fileExplorer.path.reload')}
                  onClick={() => void tree.refresh(state.root)}
                />
              );
            case 'newdir':
              return (
                <IconButton
                  key={control}
                  icon="plus"
                  className="fx-bar-button"
                  label={t('fileExplorer.path.newFolder')}
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
