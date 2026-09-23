// The workspace's file explorer: a modeless WindowDialog holding a tab strip,
// and behind it one panel per tab. Each panel owns its own useFileTree, so two
// tabs can look at two roots in two sessions (FR-FEX-003 AC-3).
//
// Nothing here unmounts to hide. A minimized window, a window of another
// workspace and an inactive tab are all display: none — tearing them down would
// throw away expanded directories and selection, which are deliberately not
// stored (design decision 20).
//
// @req FR-FEX-002
// @req FR-FEX-003
// @req FR-FEX-011

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconButton } from '../common';
import { WindowDialog } from '../dialog/WindowDialog';
import type { DialogRect, DialogSize } from '../dialog/types';
import { useFileTree } from '../../hooks/useFileTree.ts';
import type { FileExplorerTabView, FileExplorerWindowActions } from '../../hooks/useFileExplorerWindows.ts';
import './FileExplorer.css';
import { fileExplorerDialogId } from './fileExplorerDialog.ts';
import { FileExplorerPathBar } from './FileExplorerPathBar.tsx';
import { decideAnchorPersist, decideScrollRestore, type RestoreState } from './fileExplorerScrollRestore.ts';
import { FileExplorerTabBar } from './FileExplorerTabBar.tsx';
import { resolveRestoredRootFailure } from './fileExplorerTabsState.ts';
import { selectListRows, type ListSort } from './fileListView.ts';
import { FileListView } from './FileListView.tsx';
import type { FileTreeMode } from './fileTreeState.ts';
import { FileTreeView } from './FileTreeView.tsx';

// Module level so the references are stable: WindowDialog puts minSize into
// callback dependencies.
const FILE_EXPLORER_MIN_SIZE: DialogSize = { width: 320, height: 240 };
const FILE_EXPLORER_DEFAULT_RECT: DialogRect = { x: 96, y: 72, width: 560, height: 520 };

// Rows that can be an anchor: first-level entries only. Expansion is not
// restored, so a nested row saved as the anchor could never be found again, and
// its name could match a first-level entry elsewhere. '..' carries no depth.
const ANCHOR_ROW_SELECTOR = '.fx-row[data-name][data-depth="0"]';

// Scrolling moves the top row many times a second; the anchor is committed
// once the scrolling pauses, so each step does not re-render and write storage.
const ANCHOR_COMMIT_DELAY_MS = 200;

export interface FileExplorerWindowProps {
  workspaceId: string;
  tabs: readonly FileExplorerTabView[];
  activeTabId: string | null;
  /** The visibility predicate said no. The window hides; nothing unmounts. */
  hidden: boolean;
  actions: FileExplorerWindowActions;
  /**
   * A double click on an openable file. The explorer never reads a file itself:
   * the editor opens it, bound to the terminal tab the explorer tab came from.
   */
  onOpenFile: (filePath: string, tabId: string) => void;
}

interface FileExplorerTabPanelProps {
  workspaceId: string;
  tab: FileExplorerTabView;
  active: boolean;
  /** The whole window is hidden; nothing in it can be scrolled into view. */
  hidden: boolean;
  actions: FileExplorerWindowActions;
  onOpenFile: (filePath: string, tabId: string) => void;
}

const FileExplorerTabPanel = memo(function FileExplorerTabPanel({ workspaceId, tab, active, hidden, actions, onOpenFile }: FileExplorerTabPanelProps) {
  // The root the tree lists from. It follows navigation, so a session change
  // (a terminal restart rebuilds the tree's controller, which lists this root
  // again) keeps the directory the user is in rather than the one the tab
  // opened at.
  const [treeRoot, setTreeRoot] = useState(tab.tree.root);
  const [initialMode] = useState(tab.tree.mode);
  const tree = useFileTree(tab.sessionId, treeRoot, initialMode);
  const { state } = tree;

  const scrollRef = useRef<HTMLDivElement>(null);
  // The restore runs once per tab; until it has, the top row is not the user's.
  const restoreStateRef = useRef<RestoreState>('pending');
  // Set around the restore's own scrollIntoView, whose scroll events must not
  // be saved as if the user had scrolled there (Orca STA-5949).
  const programmaticScrollRef = useRef(false);

  // Navigation is reported so the stored root follows it. The first root is
  // the one the tree was built with, already in the tree's own spelling.
  const reportedRootRef = useRef(state.root);
  useEffect(() => {
    if (state.root === reportedRootRef.current) return;
    reportedRootRef.current = state.root;
    // A new root has nothing to restore; the old anchor named a row elsewhere.
    restoreStateRef.current = 'done';
    setTreeRoot(state.root);
    actions.setTabRoot(workspaceId, tab.id, state.root);
  }, [actions, state.root, tab.id, workspaceId]);

  // A restored root that no longer lists was removed while the page was
  // closed, which is not the user's doing: the tab moves to its session's
  // directory without an error. Only the first listing of the restored root
  // counts; a root the user navigates to keeps its error (SEC-FOP-001 AC-5).
  const restoreListingPendingRef = useRef(true);
  const rootStatus = state.childrenByPath.get(state.root)?.status;
  useEffect(() => {
    if (!restoreListingPendingRef.current || rootStatus === undefined || rootStatus === 'loading') return;
    restoreListingPendingRef.current = false;
    if (rootStatus !== 'error') return;
    if (resolveRestoredRootFailure({ origin: 'restore' }) !== 'fallback-to-session-cwd') return;
    if (tab.fallbackRoot === '' || tab.fallbackRoot === state.root) return;
    void tree.setRoot(tab.fallbackRoot);
  }, [rootStatus, state.root, tab.fallbackRoot, tree]);

  const setMode = useCallback((mode: FileTreeMode) => {
    tree.setMode(mode);
    actions.setTabMode(workspaceId, tab.id, mode);
  }, [actions, tab.id, tree, workspaceId]);

  const handleSortChange = useCallback((sort: ListSort) => {
    actions.setTabSort(workspaceId, tab.id, sort);
  }, [actions, tab.id, workspaceId]);

  const handleOpenFile = useCallback((filePath: string) => {
    onOpenFile(filePath, tab.originTabId);
  }, [onOpenFile, tab.originTabId]);

  // The listing in the order it is drawn: the list's sort in list mode, the
  // server's order for the tree's first level.
  const sort = state.mode === 'list' ? tab.sort : null;
  const rootEntries = selectListRows(state, sort);

  // Runs after every render until the anchor has been placed: rows arrive with
  // a later render than the one that mounted the panel, and an inactive tab has
  // nothing on screen to scroll.
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!active || hidden || container === null || restoreStateRef.current !== 'pending') return;
    const restore = decideScrollRestore({
      rowCount: container.querySelectorAll(ANCHOR_ROW_SELECTOR).length,
      anchorName: tab.scrollAnchor,
      visibleRows: rootEntries,
      sort,
    });
    if (restore.kind === 'wait') return;
    restoreStateRef.current = restore.shouldPersist ? 'done' : 'failed';
    const target = restore.name === null
      ? null
      : container.querySelector(`${ANCHOR_ROW_SELECTOR}[data-name="${CSS.escape(restore.name)}"]`);
    if (target !== null) {
      programmaticScrollRef.current = true;
      target.scrollIntoView({ block: 'start' });
      // Scroll events of this frame are dispatched before animation frame
      // callbacks, so the flag covers exactly the restore's own scroll.
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
    }
    // A fallback is never written back: a late paint would become a lost position.
    if (restore.shouldPersist && restore.name !== null) actions.setTabAnchor(workspaceId, tab.id, restore.name);
  });

  // The decision is made on each scroll event; only its commit waits.
  const pendingAnchorRef = useRef<{ decision: 'save' | 'skip'; name: string } | null>(null);
  const anchorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (anchorTimerRef.current !== null) clearTimeout(anchorTimerRef.current);
  }, []);

  const commitPendingAnchor = useCallback(() => {
    anchorTimerRef.current = null;
    const pending = pendingAnchorRef.current;
    pendingAnchorRef.current = null;
    if (pending?.decision === 'save') actions.setTabAnchor(workspaceId, tab.id, pending.name);
  }, [actions, tab.id, workspaceId]);

  const handleScroll = useCallback(() => {
    const container = scrollRef.current;
    if (container === null) return;
    const userInitiated = !programmaticScrollRef.current;
    const rowElements = container.querySelectorAll<HTMLElement>(ANCHOR_ROW_SELECTOR);
    // The first-level row at or above the top edge; inside an expanded
    // directory that is the directory itself.
    const top = container.getBoundingClientRect().top;
    let name: string | null = null;
    for (const element of rowElements) {
      if (name !== null && element.getBoundingClientRect().top > top) break;
      name = element.dataset.name ?? null;
    }
    const decision = decideAnchorPersist({
      restoreState: restoreStateRef.current,
      userInitiated,
      rowCount: rowElements.length,
    });
    if (decision !== 'save' || name === null) return;
    pendingAnchorRef.current = { decision, name };
    if (anchorTimerRef.current !== null) clearTimeout(anchorTimerRef.current);
    anchorTimerRef.current = setTimeout(commitPendingAnchor, ANCHOR_COMMIT_DELAY_MS);
  }, [commitPendingAnchor]);

  return (
    <div className={`fx-tab-panel${active ? '' : ' fx-inactive'}`} role="tabpanel">
      <FileExplorerPathBar tree={tree} setMode={setMode} />
      <div className="fx-scroll" ref={scrollRef} onScroll={handleScroll}>
        {state.mode === 'list'
          ? <FileListView tree={tree} sort={tab.sort} onSortChange={handleSortChange} onOpenFile={handleOpenFile} />
          : <FileTreeView tree={tree} onOpenFile={handleOpenFile} />}
      </div>
    </div>
  );
});

// @req FR-FEX-003
export function FileExplorerWindow({ workspaceId, tabs, activeTabId, hidden, actions, onOpenFile }: FileExplorerWindowProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const shownFrameDisplayRef = useRef<string | null>(null);
  const shownSectionDisplayRef = useRef<string | null>(null);

  // WindowDialog portals into document.body and forwards no ref, so the frame
  // (react-rnd's positioned root) and the dialog section are reached from a
  // node this component owns. Both are hidden: the section alone would leave
  // the frame's resize handles live over whatever is underneath.
  useLayoutEffect(() => {
    const section = bodyRef.current?.closest<HTMLElement>('.window-dialog-surface') ?? null;
    const frame = section?.closest<HTMLElement>('.window-dialog') ?? null;
    if (section === null || frame === null) return;
    if (shownFrameDisplayRef.current === null) shownFrameDisplayRef.current = frame.style.display;
    if (shownSectionDisplayRef.current === null) shownSectionDisplayRef.current = section.style.display;
    frame.style.display = hidden ? 'none' : shownFrameDisplayRef.current;
    section.style.display = hidden ? 'none' : shownSectionDisplayRef.current;
  }, [hidden]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  const titlebarActions = (
    <div className="fx-window-actions">
      <IconButton icon="minimize" label="최소화" onClick={() => actions.minimizeFileExplorer(workspaceId)} />
    </div>
  );

  return (
    <WindowDialog
      dialogId={fileExplorerDialogId(workspaceId)}
      title="파일 탐색기"
      mode="modeless"
      defaultRect={FILE_EXPLORER_DEFAULT_RECT}
      minSize={FILE_EXPLORER_MIN_SIZE}
      onClose={() => actions.closeFileExplorer(workspaceId)}
      showCloseButton
      resizable
      persistGeometry
      surfaceClassName="fx-window"
      titlebarActions={titlebarActions}
    >
      <div className="fx-window-body" ref={bodyRef}>
        <FileExplorerTabBar
          tabs={tabs}
          activeTabId={activeTab?.id ?? null}
          rootOf={(tab) => tab.tree.root}
          onSelect={(tabId) => actions.selectTab(workspaceId, tabId)}
          onClose={(tabId) => actions.closeTab(workspaceId, tabId)}
          onAdd={() => {
            if (activeTab !== undefined) actions.addTab(workspaceId, activeTab.tree.root);
          }}
        />
        {tabs.map((tab) => (
          <FileExplorerTabPanel
            key={tab.id}
            workspaceId={workspaceId}
            tab={tab}
            active={tab.id === activeTab?.id}
            hidden={hidden}
            actions={actions}
            onOpenFile={onOpenFile}
          />
        ))}
      </div>
    </WindowDialog>
  );
}
