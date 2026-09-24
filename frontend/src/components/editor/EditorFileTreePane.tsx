// The editor window's left file-tree pane (design 9.1): a head with the root
// path and a close button, and below it the explorer's own FileTreeView.
//
// The pane owns what it lists and what it does to files; the window owns how
// wide it is, whether it is open and where an opened file goes. The file
// operations are useFileTreeOperations, the same code path the explorer
// window's tab panel runs (FR-MDE-012 AC-8), so a paste here and a paste there
// cannot drift apart.
//
// File shortcuts are taken on this pane's root only, and only while focus is
// inside it (decidePaneShortcutFocus). Scoped to the window, a Delete typed in
// the document would delete the selected file (FR-FEX-005 AC-7).
//
// The delete confirm is the explorer's window-scoped modal, drawn inside this
// pane: never portalled and never on the dialog stack, so a question here
// blocks neither the document beside it nor any other window (DR-12).
//
// @req FR-MDE-012
// @req FR-FEX-005

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { IconButton } from '../common';
import { ContextMenu } from '../ContextMenu/ContextMenu';
import { useWebSocketActions } from '../../contexts/WebSocketContext';
import { useFileTree } from '../../hooks/useFileTree.ts';
import { useFileTreeOperations } from '../../hooks/useFileTreeOperations.ts';
import { normalizeTreePath } from '../fileExplorer/fileTreeController.ts';
// The rows, the confirm row and the modal are the explorer's; their rules live
// in its stylesheet and read the paper tokens this pane's root selects.
import '../fileExplorer/FileExplorer.css';
import type { ListSort } from '../fileExplorer/fileListView.ts';
import { getFileExplorerClipboard, subscribeFileExplorerClipboard } from '../fileExplorer/fileExplorerClipboard.ts';
import { FileExplorerConfirmBar, useFileExplorerConfirmBar } from '../fileExplorer/FileExplorerConfirmBar.tsx';
import { FileExplorerWindowModal, useFileExplorerWindowModal } from '../fileExplorer/FileExplorerWindowModal.tsx';
import { createFileExplorerShortcutHandler, isExplorerTextSelection } from '../fileExplorer/fileExplorerShortcuts.ts';
import { routeFileJobMessage } from '../fileExplorer/fileJobEvents.ts';
import { FileTreeView, type FileExplorerMenuRequest } from '../fileExplorer/FileTreeView.tsx';
import { decidePaneShortcutFocus, resolvePaneRoot } from './editorFileTreePaneModel.ts';

export interface EditorFileTreePaneProps {
  /** Where a submitted job belongs, so that workspace's explorer can ask its questions. */
  workspaceId: string;
  /** The terminal tab the pane follows: the editor window's active tab. */
  tabId: string;
  /** The session that tab is bound to. A change re-roots the pane. */
  sessionId: string;
  /** That session's working directory: the root until the user moves it. */
  sessionCwd: string;
  /** Folded. The pane stays mounted so expansion and selection survive reopening. */
  hidden: boolean;
  /** On a phone the pane floats over the document instead of pushing it aside. */
  isMobile: boolean;
  /** The width the window decided to draw it at. */
  style: CSSProperties;
  onClose: () => void;
  onOpenFile: (filePath: string) => void;
}

/**
 * @req FR-MDE-012
 * @req FR-FEX-005
 */
export function EditorFileTreePane({
  workspaceId,
  tabId,
  sessionId,
  sessionCwd,
  hidden,
  isMobile,
  style,
  onClose,
  onOpenFile,
}: EditorFileTreePaneProps) {
  // The pane's own header sort (not stored): the explorer window's tabs keep theirs.
  const [sort, setSort] = useState<ListSort | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // The root the user last had on screen, and in which session. A root moved
  // inside the tree ('..', or a future "open here") is kept while the session
  // stays; a new session starts again from its working directory (AC-5).
  const [previousRoot, setPreviousRoot] = useState<{ sessionId: string; root: string } | null>(null);
  const treeRoot = resolvePaneRoot({ previous: previousRoot, sessionId, sessionCwd });
  const tree = useFileTree(sessionId, treeRoot, 'tree');
  const { state, applyJobDone } = tree;

  // At the render that brings a new session the tree still holds the old root,
  // so a session change records the new session's directory rather than what
  // is listed; recording the listed root would pin the new session to the old
  // session's folder. Recorded even when the two spell the same path, or the
  // pane would keep following the new session's cd.
  useEffect(() => {
    setPreviousRoot((previous) => {
      const root = previous?.sessionId === sessionId ? state.root : normalizeTreePath(sessionCwd);
      return previous?.sessionId === sessionId && previous.root === root ? previous : { sessionId, root };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a cd in the session must not re-root the pane
  }, [sessionId, state.root]);

  const { registerFileJobHandler } = useWebSocketActions();
  const clipboard = useSyncExternalStore(subscribeFileExplorerClipboard, getFileExplorerClipboard);
  const confirmBar = useFileExplorerConfirmBar();
  const { askName, showError } = confirmBar;
  const paneModal = useFileExplorerWindowModal();
  const [menu, setMenu] = useState<FileExplorerMenuRequest | null>(null);

  // A finished job refreshes the directories it touched here, whoever started
  // it; the operations hook submits but does not refresh.
  useEffect(() => registerFileJobHandler((msg) => {
    const route = routeFileJobMessage(msg);
    if (route === null || route.sessionId !== sessionId) return;
    if (route.kind === 'invalidate') void applyJobDone(route.directories);
  }), [applyJobDone, registerFileJobHandler, sessionId]);

  // No onNewTab: the pane has no tabs, so the menu offers no "open in new tab".
  const ops = useFileTreeOperations({
    sessionId,
    tree,
    menu,
    context: 'editor-panel',
    confirm: paneModal.confirm,
    askName,
    showError,
    onOpenFile,
    origin: { workspaceId, tabId },
  });

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => createFileExplorerShortcutHandler({
    getContext: () => ({
      focusedInSurface: decidePaneShortcutFocus({ pane: rootRef.current, document: null, active: document.activeElement }),
      selectionCount: state.selectedPaths.size,
      // Selected text in the head or the confirm row is what a Ctrl+C then means.
      hasTextSelection: isExplorerTextSelection(window.getSelection(), rootRef.current),
    }),
    run: ops.runShortcut,
  })(event);

  return (
    // Focusable so that a click on a row puts focus inside the pane, which is
    // what the shortcut focus test asks.
    <div
      ref={rootRef}
      className={`editor-tree-pane${isMobile ? ' editor-tree-pane-overlay' : ''}`}
      data-surface="paper"
      style={hidden ? { ...style, display: 'none' } : style}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <div className="editor-tree-pane-head">
        <span className="editor-tree-pane-root" title={state.root}>{state.root}</span>
        <IconButton icon="close" label="닫기" onClick={() => onClose()} />
      </div>
      <div className="fx-scroll">
        <FileTreeView tree={tree} clipboard={clipboard} onOpenFile={onOpenFile} onOpenMenu={setMenu} renaming={ops.rowRename} sort={sort} onSortChange={setSort} />
      </div>
      <FileExplorerConfirmBar prompt={confirmBar.prompt} error={confirmBar.error} onDismissError={confirmBar.dismissError} />
      <FileExplorerWindowModal modal={paneModal} />
      {menu !== null && (
        <ContextMenu position={{ x: menu.x, y: menu.y }} items={ops.menuItems} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
