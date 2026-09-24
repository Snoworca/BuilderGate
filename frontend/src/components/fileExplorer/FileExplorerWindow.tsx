// The workspace's file explorer: a modeless WindowDialog holding a tab strip,
// and behind it one panel per tab. Each panel owns its own useFileTree, so two
// tabs can look at two roots in two sessions (FR-FEX-003 AC-3).
//
// Nothing here unmounts to hide. A minimized window, a window of another
// workspace and an inactive tab are all display: none — tearing them down would
// throw away expanded directories and selection, which are deliberately not
// stored (design decision 20).
//
// Each panel also owns its file operations: the context menu, the mobile button
// row, the in-window confirm row and inline rename. The operations themselves
// are useFileTreeOperations, shared with the editor's tree pane, so the two
// surfaces have one code path (FR-MDE-012 AC-8). The window only routes keys
// to the active panel, and only while focus is inside its own surface (DR-16).
//
// File jobs live in the app-wide store (fileJobStore), not in a panel: a panel
// records the job it submitted there, and the window asks the questions and
// shows the failures of its workspace's jobs. Nothing is cancelled when a
// window goes away, so a question waits in the store until the window is
// opened again (FR-FEX-009 AC-3).
//
// 최대화 fills the terminal stage the same way an editor window does: the
// stage is measured and handed to the dialog as a controlled rect. Back in
// floating, the dialog is uncontrolled again and finds its persisted rect.
//
// @req FR-FEX-002
// @req FR-FEX-003
// @req FR-FEX-004
// @req FR-FEX-011
// @req FR-FEX-008
// @req FR-FEX-009

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent, PointerEvent, RefObject, TouchEvent } from 'react';
import { IconButton, IconToggleButton } from '../common';
import { ContextMenu } from '../ContextMenu/ContextMenu';
import { WindowDialog } from '../dialog/WindowDialog';
import type { DialogRect, DialogSize } from '../dialog/types';
import { EDITOR_WINDOW_BOUNDS_SELECTOR } from '../editor/editorWindowBounds.ts';
import type { EditorWindowPlacement } from '../editor/editorWindowPlacement.ts';
import { toStageRect } from '../editor/editorWindowRect.ts';
import { useWebSocketActions } from '../../contexts/WebSocketContext';
import { useFileTree } from '../../hooks/useFileTree.ts';
import type { FileExplorerTabView, FileExplorerWindowActions } from '../../hooks/useFileExplorerWindows.ts';
import { useFileTreeOperations, type FileTreeShortcutAction } from '../../hooks/useFileTreeOperations.ts';
import { useLongPress } from '../../hooks/useLongPress.ts';
import { useResponsive } from '../../hooks/useResponsive.ts';
import { fileJobApi } from '../../services/api.ts';
import './FileExplorer.css';
import { getFileExplorerClipboard, subscribeFileExplorerClipboard } from './fileExplorerClipboard.ts';
import { FileExplorerConfirmBar, useFileExplorerConfirmBar } from './FileExplorerConfirmBar.tsx';
import { FileExplorerWindowModal, useFileExplorerWindowModal, type FileExplorerWindowModalState } from './FileExplorerWindowModal.tsx';
import { fileExplorerDialogId } from './fileExplorerDialog.ts';
import { FileExplorerMobileBar } from './FileExplorerMobileBar.tsx';
import { FileExplorerPathBar } from './FileExplorerPathBar.tsx';
import { FileExplorerProgressRow } from './FileExplorerProgressRow.tsx';
import { decideAnchorPersist, decideScrollRestore, pickAnchorRow, type RestoreState } from './fileExplorerScrollRestore.ts';
import { createFileExplorerShortcutHandler, isExplorerTextSelection } from './fileExplorerShortcuts.ts';
import { FileExplorerTabBar } from './FileExplorerTabBar.tsx';
import { firstListingFailureAction } from './fileExplorerTabsState.ts';
import { routeFileJobMessage } from './fileJobEvents.ts';
import {
  dispatchFileJob,
  getFileJobSnapshot,
  selectPendingDecisionsForWindow,
  selectWindowFailures,
  subscribeFileJobs,
  type FileJobDecideRoute,
} from './fileJobStore.ts';
import { selectListRows, type ListSort } from './fileListView.ts';
import { FileListView } from './FileListView.tsx';
import { decideRowPointer } from './fileRowInteraction.ts';
import type { FileTreeMode } from './fileTreeState.ts';
import { FileTreeView, type FileExplorerMenuRequest } from './FileTreeView.tsx';

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

type ShortcutAction = FileTreeShortcutAction;

/** What the window's key handler needs from the panel on screen. */
interface PanelCommands {
  selectionCount: number;
  run: (action: ShortcutAction) => void;
  /** Saves a scroll position still waiting for its settle timer, now. */
  flushAnchor: () => void;
  /** Puts a message on the panel's error line; the window uses it for its jobs' failures. */
  showError: (message: string) => void;
}

type RegisterPanelCommands = (tabId: string, commands: RefObject<PanelCommands | null>) => () => void;

function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error);
}

export interface FileExplorerWindowProps {
  workspaceId: string;
  tabs: readonly FileExplorerTabView[];
  activeTabId: string | null;
  /** The visibility predicate said no. The window hides; nothing unmounts. */
  hidden: boolean;
  /** 'stage' while maximized over the terminal area. */
  placement: EditorWindowPlacement;
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
  registerCommands: RegisterPanelCommands;
  /** The window's one modal: every tab asks its delete and job questions here. */
  windowModal: FileExplorerWindowModalState;
}

const FileExplorerTabPanel = memo(function FileExplorerTabPanel({ workspaceId, tab, active, hidden, actions, onOpenFile, registerCommands, windowModal }: FileExplorerTabPanelProps) {
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
    // A tab the user just opened is not a restored root: its failure stays on
    // screen rather than silently moving the tab.
    if (firstListingFailureAction(tab) !== 'fallback-to-session-cwd') return;
    if (tab.fallbackRoot === '' || tab.fallbackRoot === state.root) return;
    void tree.setRoot(tab.fallbackRoot);
  }, [rootStatus, state.root, tab, tree]);

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

  // The controller's functions are stable for a session, so effects depend on
  // them rather than on the tree result, which changes with every state update.
  const { applyJobDone } = tree;

  const { isMobile } = useResponsive();
  const { registerFileJobHandler } = useWebSocketActions();
  const clipboard = useSyncExternalStore(subscribeFileExplorerClipboard, getFileExplorerClipboard);
  const confirmBar = useFileExplorerConfirmBar();
  const { askName, showError } = confirmBar;
  const { confirm: confirmDelete } = windowModal;
  const [menu, setMenu] = useState<FileExplorerMenuRequest | null>(null);

  // Every finished job refreshes the directories it touched in this tab, whoever
  // started it: a failed or cancelled job may still have changed some files.
  // Progress, questions and finishes reach the store at the app level
  // (useFileJobStoreSync); only the tab's own tree refresh is done here.
  useEffect(() => registerFileJobHandler((msg) => {
    const route = routeFileJobMessage(msg);
    if (route === null || route.sessionId !== tab.sessionId) return;
    if (route.kind === 'invalidate') void applyJobDone(route.directories);
  }), [applyJobDone, registerFileJobHandler, tab.sessionId]);

  // The file operations are shared with the editor's tree pane. The job each
  // one submits is recorded in the store under this window's workspace; the
  // delete is asked in the window's modal, a folder name in the confirm row.
  const ops = useFileTreeOperations({
    sessionId: tab.sessionId,
    tree,
    menu,
    context: 'explorer-window',
    confirm: confirmDelete,
    askName,
    showError,
    onOpenFile: handleOpenFile,
    onNewTab: (path) => actions.addTab(workspaceId, path),
    origin: { workspaceId, tabId: tab.id },
  });
  const commandsRef = useRef<PanelCommands | null>(null);
  useLayoutEffect(() => {
    commandsRef.current = { selectionCount: state.selectedPaths.size, run: ops.runShortcut, flushAnchor: commitPendingAnchor, showError };
  });
  useEffect(() => registerCommands(tab.id, commandsRef), [registerCommands, tab.id]);

  // A long press is the touch spelling of a right click. It goes through the
  // same pointer decision as a secondary button, which never changes the
  // selection itself, and then raises the contextmenu the views already handle,
  // so there is one menu path rather than two.
  const pressTargetRef = useRef<EventTarget | null>(null);
  const handleLongPress = useCallback(({ clientX, clientY }: { clientX: number; clientY: number }) => {
    const pointer = decideRowPointer({ button: 2, ctrlKey: false, metaKey: false, shiftKey: false, isSelected: false });
    if (pointer.type !== 'noop') return;
    const target = pressTargetRef.current;
    if (!(target instanceof Element) || !target.isConnected) return;
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY }));
  }, []);
  const longPress = useLongPress(handleLongPress);
  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    pressTargetRef.current = event.target;
    longPress.onTouchStart(event);
  };

  // The listing in the order it is drawn: the tab's sort, which both modes share
  // (the tree's header sorts its first level the same way).
  const sort = tab.sort;
  // Re-sorted only when the root's listing entry or the sort changes, not on
  // every selection click; a listing entry is replaced, never mutated.
  const rootListing = state.childrenByPath.get(state.root);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the listing entry, not the whole state
  const rootEntries = useMemo(() => selectListRows(state, sort), [rootListing, sort]);

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

  // Whether a scroll may be saved is decided on each scroll event, because the
  // programmatic-scroll flag is only true during the restore's own frame. The
  // top row is searched for once the scrolling settles: reading every row's
  // position forces a layout, which is too much for each scroll event.
  const pendingAnchorRef = useRef<{ decision: 'save' | 'skip' } | null>(null);
  const anchorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (anchorTimerRef.current !== null) clearTimeout(anchorTimerRef.current);
  }, []);

  const commitPendingAnchor = useCallback(() => {
    if (anchorTimerRef.current !== null) clearTimeout(anchorTimerRef.current);
    anchorTimerRef.current = null;
    const pending = pendingAnchorRef.current;
    pendingAnchorRef.current = null;
    const container = scrollRef.current;
    if (container === null || pending === null) return;
    // No client rects means display: none somewhere above; every row would
    // measure 0 and the search would name the last row.
    const hasLayout = container.getClientRects().length > 0;
    function* rowTops(root: HTMLElement) {
      for (const element of root.querySelectorAll<HTMLElement>(ANCHOR_ROW_SELECTOR)) {
        yield { name: element.dataset.name ?? '', top: element.getBoundingClientRect().top };
      }
    }
    const name = pickAnchorRow(hasLayout ? container.getBoundingClientRect().top : 0, rowTops(container), hasLayout);
    if (pending.decision === 'save' && name !== null && name !== '') actions.setTabAnchor(workspaceId, tab.id, name);
  }, [actions, tab.id, workspaceId]);

  // Hiding ends the scroll, so a commit still waiting for its timer runs now,
  // while the rows are laid out: the window's display: none comes from its own
  // layout effect, which runs after this child's. An inactive tab is already
  // hidden by its className here, so the window flushes before switching tabs
  // (flushAnchor); this effect then finds no layout and drops nothing it could
  // have saved.
  useLayoutEffect(() => {
    if ((active && !hidden) || anchorTimerRef.current === null) return;
    clearTimeout(anchorTimerRef.current);
    commitPendingAnchor();
  }, [active, hidden, commitPendingAnchor]);

  const handleScroll = useCallback(() => {
    const container = scrollRef.current;
    if (container === null) return;
    const userInitiated = !programmaticScrollRef.current;
    const decision = decideAnchorPersist({
      restoreState: restoreStateRef.current,
      userInitiated,
      rowCount: container.querySelectorAll(ANCHOR_ROW_SELECTOR).length,
    });
    if (decision !== 'save') return;
    pendingAnchorRef.current = { decision };
    if (anchorTimerRef.current !== null) clearTimeout(anchorTimerRef.current);
    anchorTimerRef.current = setTimeout(commitPendingAnchor, ANCHOR_COMMIT_DELAY_MS);
  }, [commitPendingAnchor]);

  // A text selection left in the window (a path dragged over in the confirm
  // row) would otherwise keep Ctrl+C meaning text after the user went back to
  // the rows. The rename input keeps its own caret.
  const handleRowsPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest('input, textarea') !== null) return;
    window.getSelection()?.removeAllRanges();
  };

  return (
    <div className={`fx-tab-panel${active ? '' : ' fx-inactive'}`} role="tabpanel">
      <FileExplorerPathBar tree={tree} setMode={setMode} onNewDirectory={() => void ops.createDirectoryIn(state.root)} />
      <div
        className="fx-scroll"
        ref={scrollRef}
        onScroll={handleScroll}
        onPointerDown={handleRowsPointerDown}
        onTouchStart={handleTouchStart}
        onTouchMove={longPress.onTouchMove}
        onTouchEnd={longPress.onTouchEnd}
      >
        {state.mode === 'list'
          ? (
            <FileListView
              tree={tree}
              sort={tab.sort}
              onSortChange={handleSortChange}
              clipboard={clipboard}
              onOpenFile={handleOpenFile}
              onOpenMenu={setMenu}
              renaming={ops.rowRename}
            />
          )
          : <FileTreeView tree={tree} clipboard={clipboard} onOpenFile={handleOpenFile} onOpenMenu={setMenu} renaming={ops.rowRename} sort={tab.sort} onSortChange={handleSortChange} />}
      </div>
      <FileExplorerConfirmBar prompt={confirmBar.prompt} error={confirmBar.error} onDismissError={confirmBar.dismissError} />
      {isMobile && (
        <FileExplorerMobileBar selectionCount={state.selectedPaths.size} clipboardEmpty={clipboard === null} handlers={ops.menuHandlers} />
      )}
      {menu !== null && (
        <ContextMenu position={{ x: menu.x, y: menu.y }} items={ops.menuItems} onClose={() => setMenu(null)} />
      )}
    </div>
  );
});

/**
 * The terminal stage in dialog coordinates while `active`, or null when it is
 * not measured (inactive, or no stage element on screen). Re-measured as the
 * stage resizes, since the sidebar and the window size both move it.
 * @req FR-FEX-004
 */
function useStageRect(active: boolean): DialogRect | null {
  const [rect, setRect] = useState<DialogRect | null>(null);
  useLayoutEffect(() => {
    if (!active) return undefined;
    const stage = document.querySelector<HTMLElement>(EDITOR_WINDOW_BOUNDS_SELECTOR);
    if (stage === null) return undefined;
    const measure = () => {
      const next = toStageRect(stage.getBoundingClientRect());
      setRect((current) => (current !== null
        && current.x === next.x && current.y === next.y
        && current.width === next.width && current.height === next.height ? current : next));
    };
    measure();
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(stage);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [active]);
  // Derived rather than cleared from the effect: an inactive window has no
  // stage rect, and the last measurement is replaced before paint when it is
  // active again.
  return active ? rect : null;
}

// @req FR-FEX-003
export function FileExplorerWindow({ workspaceId, tabs, activeTabId, hidden, placement, actions, onOpenFile }: FileExplorerWindowProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const maximized = placement === 'stage';
  const stageRect = useStageRect(maximized && !hidden);
  const windowModal = useFileExplorerWindowModal();
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

  // Keys go to the panel on screen. Panels register a ref rather than values so
  // the handler reads the selection as it is at the moment of the press.
  const panelCommandsRef = useRef(new Map<string, RefObject<PanelCommands | null>>());
  const activeTabIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    activeTabIdRef.current = activeTab?.id ?? null;
  });
  // A tab switch hides the panel through its className in the same commit, so
  // its layout is gone before any of its effects run; the scroll position it
  // is still waiting to save is committed here, before the switch.
  const flushActiveAnchor = () => {
    const id = activeTabIdRef.current;
    if (id !== null) panelCommandsRef.current.get(id)?.current?.flushAnchor();
  };
  const registerPanelCommands = useCallback<RegisterPanelCommands>((tabId, commands) => {
    const registry = panelCommandsRef.current;
    registry.set(tabId, commands);
    return () => {
      if (registry.get(tabId) === commands) registry.delete(tabId);
    };
  }, []);

  // A job's failure goes to the tab that started it when that tab is still
  // open, and to the panel on screen otherwise: the tab may be closed by the
  // time it arrives. Whether a panel showed it is returned, so a failure no
  // panel could show stays in the store for the next chance.
  const showJobError = useCallback((message: string, originTabId: string | null = null): boolean => {
    const registry = panelCommandsRef.current;
    const activeId = activeTabIdRef.current;
    const panel = (originTabId === null ? null : registry.get(originTabId)?.current ?? null)
      ?? (activeId === null ? null : registry.get(activeId)?.current ?? null);
    if (panel === null) return false;
    panel.showError(message);
    return true;
  }, []);

  // The selectors build a new array on every call, so they run on the snapshot
  // inside useMemo rather than as the store's getSnapshot.
  const jobSnapshot = useSyncExternalStore(subscribeFileJobs, getFileJobSnapshot);
  const pendingDecisions = useMemo(() => selectPendingDecisionsForWindow(jobSnapshot, workspaceId), [jobSnapshot, workspaceId]);
  const jobFailures = useMemo(() => selectWindowFailures(jobSnapshot, workspaceId), [jobSnapshot, workspaceId]);

  // Questions put to the modal and not yet answered, by job. The store keeps a
  // decision pending until DECISION_ANSWERED, so without this every store
  // update would queue the same question again.
  const askedDecisionsRef = useRef(new Map<string, string>());
  const { dropJob } = windowModal;

  // A POST that failed leaves the question unanswered on the server, so it is
  // asked again; this counter re-runs the asking effect for it.
  const [reaskTick, setReaskTick] = useState(0);

  const askDecision = useCallback((route: FileJobDecideRoute) => {
    askedDecisionsRef.current.set(route.jobId, route.decisionId);
    void windowModal.decideJob(route.jobId, route.detail)
      .then(async (answer) => {
        // Withdrawn: the job finished, or stopped waiting, before an answer.
        if (answer === null) return;
        // '취소' / Escape: the question is withdrawn by ending the job itself.
        if (answer.kind === 'cancel-job') {
          await fileJobApi.cancel(route.jobId);
        } else {
          await fileJobApi.decide(route.jobId, {
            decisionId: route.decisionId,
            choice: answer.choice,
            applyToAll: answer.applyToAll,
          });
        }
        // Settled only once the server took the answer. Until then the job is
        // still marked asked, so a store update meanwhile does not put the same
        // question up again.
        const asked = askedDecisionsRef.current;
        if (asked.get(route.jobId) === route.decisionId) asked.delete(route.jobId);
        dispatchFileJob({ type: 'DECISION_ANSWERED', jobId: route.jobId, decisionId: route.decisionId });
      })
      .catch((error: unknown) => {
        showJobError(`결정을 보내지 못했습니다: ${messageOf(error)}`);
        // The store still holds the question. Forgetting that it was asked lets
        // the effect put it up again; a job that is gone withdraws it on done.
        const asked = askedDecisionsRef.current;
        if (asked.get(route.jobId) === route.decisionId) asked.delete(route.jobId);
        setReaskTick((tick) => tick + 1);
      });
  }, [windowModal, showJobError]);

  // A mounted window asks every question its workspace's jobs are waiting on,
  // including ones that arrived while it was closed. A question the store no
  // longer holds (its job ended, or another client answered) is withdrawn.
  useEffect(() => {
    const asked = askedDecisionsRef.current;
    const pendingByJob = new Map(pendingDecisions.map((route) => [route.jobId, route.decisionId]));
    for (const [jobId, decisionId] of [...asked]) {
      if (pendingByJob.get(jobId) === decisionId) continue;
      asked.delete(jobId);
      dropJob(jobId);
    }
    for (const route of pendingDecisions) {
      if (asked.get(route.jobId) !== route.decisionId) askDecision(route);
    }
  }, [askDecision, dropJob, pendingDecisions, reaskTick]);

  // Each failure is shown once, in this window only, and released only once a
  // panel actually showed it.
  useEffect(() => {
    for (const failure of jobFailures) {
      const shown = showJobError(`파일 작업이 실패했습니다${failure.errorCode ? ` (${failure.errorCode})` : ''}`, failure.tabId);
      if (shown) dispatchFileJob({ type: 'FAILURE_SHOWN', jobId: failure.jobId });
    }
  }, [jobFailures, showJobError]);

  // Focus is judged by containment in this surface, so a Ctrl+C typed in a
  // terminal never reaches the explorer (DR-16).
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => createFileExplorerShortcutHandler({
    getContext: () => {
      const id = activeTabIdRef.current;
      const commands = id === null ? null : panelCommandsRef.current.get(id)?.current ?? null;
      const textSelection = window.getSelection();
      return {
        focusedInSurface: bodyRef.current?.contains(document.activeElement) ?? false,
        selectionCount: commands?.selectionCount ?? 0,
        // Selected text in the path bar or the confirm row is what a Ctrl+C
        // then means, as everywhere else in the browser. Text over the rows or
        // elsewhere on the page does not count.
        hasTextSelection: isExplorerTextSelection(textSelection, bodyRef.current),
      };
    },
    run: (action) => {
      const id = activeTabIdRef.current;
      if (id !== null) panelCommandsRef.current.get(id)?.current?.run(action);
    },
  })(event);

  const titlebarActions = (
    <div className="fx-window-actions">
      <IconToggleButton
        pressed={maximized}
        icons={{ on: 'restore', off: 'maximize' }}
        label="최대화"
        onToggle={() => actions.toggleMaximizeFileExplorer(workspaceId)}
      />
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
      // Maximized, the window is the stage: a drag or resize would emit a rect
      // the stage would take straight back, and would store it as the floating
      // geometry. Without a measurable stage it stays where it floated.
      rect={maximized ? stageRect ?? undefined : undefined}
      movable={!maximized}
      resizable={!maximized}
      persistGeometry
      surfaceClassName="fx-window"
      titlebarActions={titlebarActions}
    >
      {/* Focusable so that a click on a row puts focus inside the surface, which
          is what the shortcut handler checks. */}
      <div className="fx-window-body" ref={bodyRef} tabIndex={-1} onKeyDown={handleKeyDown}>
        <FileExplorerTabBar
          tabs={tabs}
          activeTabId={activeTab?.id ?? null}
          rootOf={(tab) => tab.tree.root}
          onSelect={(tabId) => {
            flushActiveAnchor();
            actions.selectTab(workspaceId, tabId);
          }}
          onClose={(tabId) => actions.closeTab(workspaceId, tabId)}
          onAdd={() => {
            flushActiveAnchor();
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
            registerCommands={registerPanelCommands}
            windowModal={windowModal}
          />
        ))}
        <FileExplorerProgressRow workspaceId={workspaceId} />
        <FileExplorerWindowModal modal={windowModal} />
      </div>
    </WindowDialog>
  );
}
