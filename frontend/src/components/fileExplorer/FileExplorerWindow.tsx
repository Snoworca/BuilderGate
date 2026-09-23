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
// row, the in-window confirm row, inline rename and the answers to its own file
// jobs. The window only routes keys to the active panel, and only while focus is
// inside its own surface (DR-16).
//
// @req FR-FEX-002
// @req FR-FEX-003
// @req FR-FEX-011

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent, RefObject, TouchEvent } from 'react';
import { IconButton } from '../common';
import { ContextMenu } from '../ContextMenu/ContextMenu';
import { WindowDialog } from '../dialog/WindowDialog';
import type { DialogRect, DialogSize } from '../dialog/types';
import { useWebSocketActions } from '../../contexts/WebSocketContext';
import { useFileTree } from '../../hooks/useFileTree.ts';
import type { FileExplorerTabView, FileExplorerWindowActions } from '../../hooks/useFileExplorerWindows.ts';
import { useInlineRename } from '../../hooks/useInlineRename.ts';
import { useLongPress } from '../../hooks/useLongPress.ts';
import { useResponsive } from '../../hooks/useResponsive.ts';
import { fileApi, fileJobApi } from '../../services/api.ts';
import './FileExplorer.css';
import {
  copySelection,
  cutSelection,
  getFileExplorerClipboard,
  subscribeFileExplorerClipboard,
} from './fileExplorerClipboard.ts';
import { FileExplorerConfirmBar, useFileExplorerConfirmBar } from './FileExplorerConfirmBar.tsx';
import { buildFileExplorerContextMenuItems, type FileExplorerMenuHandlers } from './fileExplorerContextMenu.ts';
import { fileExplorerDialogId } from './fileExplorerDialog.ts';
import { FileExplorerMobileBar } from './FileExplorerMobileBar.tsx';
import { FileExplorerPathBar } from './FileExplorerPathBar.tsx';
import { decideAnchorPersist, decideScrollRestore, type RestoreState } from './fileExplorerScrollRestore.ts';
import { createFileExplorerShortcutHandler, type FileExplorerShortcutDecision } from './fileExplorerShortcuts.ts';
import { FileExplorerTabBar } from './FileExplorerTabBar.tsx';
import { resolveRestoredRootFailure } from './fileExplorerTabsState.ts';
import { pasteFromClipboard, requestDelete, type FileJobRequest } from './fileJobClient.ts';
import { routeFileJobMessage, type FileJobRoute } from './fileJobEvents.ts';
import { selectListRows, type ListSort } from './fileListView.ts';
import { FileListView } from './FileListView.tsx';
import { decideRowPointer, isOpenableFile } from './fileRowInteraction.ts';
import { parentPathOf, type FileTreeMode } from './fileTreeState.ts';
import { FileTreeView, type FileExplorerMenuRequest, type FileRowRename } from './FileTreeView.tsx';

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

type ShortcutAction = Exclude<FileExplorerShortcutDecision, { kind: 'ignore' }>;
type DecideRoute = Extract<FileJobRoute, { kind: 'decide' }>;

/** What the window's key handler needs from the panel on screen. */
interface PanelCommands {
  selectionCount: number;
  run: (action: ShortcutAction) => void;
}

type RegisterPanelCommands = (tabId: string, commands: RefObject<PanelCommands | null>) => () => void;

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? path;
}

// Joined with the parent's own separator and never doubled, as the tree joins
// its children, so the new path is spelled like the rows around it.
function childPath(parent: string, name: string): string {
  if (parent.endsWith('/') || parent.endsWith('\\')) return parent + name;
  return parent + (parent.includes('\\') ? '\\' : '/') + name;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error);
}

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
  registerCommands: RegisterPanelCommands;
}

const FileExplorerTabPanel = memo(function FileExplorerTabPanel({ workspaceId, tab, active, hidden, actions, onOpenFile, registerCommands }: FileExplorerTabPanelProps) {
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

  // The controller's functions are stable for a session, so effects and
  // callbacks depend on them rather than on the tree result, which changes with
  // every state update.
  const { applyJobDone } = tree;

  const { isMobile } = useResponsive();
  const { registerFileJobHandler } = useWebSocketActions();
  const clipboard = useSyncExternalStore(subscribeFileExplorerClipboard, getFileExplorerClipboard);
  const confirmBar = useFileExplorerConfirmBar();
  const { decideJob, dropJob, confirm: confirmDelete, askName, showError } = confirmBar;
  const [menu, setMenu] = useState<FileExplorerMenuRequest | null>(null);

  // Only jobs this panel started are answered here: another tab on the same
  // session receives the same events and must not ask the same question twice.
  // A question can arrive before the POST that started its job has returned, so
  // unclaimed ones wait until their job is claimed or finishes.
  const ownJobsRef = useRef(new Set<string>());
  const waitingDecisionsRef = useRef(new Map<string, DecideRoute>());

  const answerDecision = useCallback((route: DecideRoute) => {
    void decideJob(route.jobId, route.detail)
      .then((answer) => {
        // Withdrawn: the job finished (or stopped waiting) before an answer.
        if (answer === null) return undefined;
        return fileJobApi.decide(route.jobId, {
          decisionId: route.decisionId,
          choice: answer.choice,
          applyToAll: answer.applyToAll,
        });
      })
      .catch((error: unknown) => showError(`결정을 보내지 못했습니다: ${messageOf(error)}`));
  }, [decideJob, showError]);

  const jobClient = useMemo(() => ({
    submit: async (request: FileJobRequest) => {
      const result = await fileJobApi.submit(request);
      ownJobsRef.current.add(result.jobId);
      const waiting = waitingDecisionsRef.current.get(result.jobId);
      if (waiting !== undefined) {
        waitingDecisionsRef.current.delete(result.jobId);
        answerDecision(waiting);
      }
      return result;
    },
  }), [answerDecision]);

  // Every finished job refreshes the directories it touched in this tab, whoever
  // started it: a failed or cancelled job may still have changed some files.
  useEffect(() => registerFileJobHandler((msg) => {
    const route = routeFileJobMessage(msg);
    if (route === null || route.sessionId !== tab.sessionId) return;
    if (route.kind === 'invalidate') {
      void applyJobDone(route.directories);
      if (msg.type !== 'file-job:done') return;
      waitingDecisionsRef.current.delete(msg.jobId);
      dropJob(msg.jobId);
      if (ownJobsRef.current.delete(msg.jobId) && msg.outcome === 'failed') {
        showError(`파일 작업이 실패했습니다${msg.errorCode ? ` (${msg.errorCode})` : ''}`);
      }
    } else if (route.kind === 'decide') {
      if (ownJobsRef.current.has(route.jobId)) answerDecision(route);
      else waitingDecisionsRef.current.set(route.jobId, route);
    }
  }), [answerDecision, applyJobDone, dropJob, registerFileJobHandler, showError, tab.sessionId]);

  const renamingPathRef = useRef<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  // The inline editor commits on Enter and again on blur; the ref makes the
  // second commit a no-op.
  const commitRename = useCallback(async (name: string) => {
    const source = renamingPathRef.current;
    renamingPathRef.current = null;
    setRenamingPath(null);
    if (source === null || name === lastSegment(source)) return;
    if (/[\\/]/.test(name)) {
      showError('이름에 경로 구분자를 쓸 수 없습니다');
      return;
    }
    const parent = parentPathOf(source);
    try {
      await fileApi.moveFile(tab.sessionId, source, childPath(parent, name));
      await applyJobDone([parent]);
    } catch (error) {
      showError(`이름을 바꾸지 못했습니다: ${messageOf(error)}`);
    }
  }, [applyJobDone, showError, tab.sessionId]);

  const rename = useInlineRename({
    onRename: (name) => {
      void commitRename(name);
    },
  });

  const { startEdit } = rename;
  const beginRename = useCallback((path: string) => {
    renamingPathRef.current = path;
    setRenamingPath(path);
    startEdit(lastSegment(path));
  }, [startEdit]);

  const rowRename: FileRowRename | null = rename.isEditing && renamingPath !== null
    ? {
        path: renamingPath,
        editName: rename.editName,
        inputRef: rename.inputRef,
        handleChange: rename.handleChange,
        // Escape unmounts the focused input, and Chromium then fires blur, which
        // the hook commits; dropping the target first makes that commit a no-op.
        handleKeyDown: (event) => {
          if (event.key === 'Escape') renamingPathRef.current = null;
          rename.handleKeyDown(event);
        },
        handleBlur: rename.handleBlur,
      }
    : null;

  const createDirectoryIn = async (directory: string) => {
    const name = await askName('새 폴더 이름', '새 폴더');
    if (name === null) return;
    if (/[\\/]/.test(name)) {
      showError('이름에 경로 구분자를 쓸 수 없습니다');
      return;
    }
    try {
      await fileApi.createDirectory(tab.sessionId, directory, name);
      await applyJobDone([directory]);
    } catch (error) {
      showError(`폴더를 만들지 못했습니다: ${messageOf(error)}`);
    }
  };

  // Menu actions act on the selection, which the view settled before opening
  // the menu; handlers are rebuilt every render, so this is the selection on
  // screen. A menu opened on a directory row pastes and creates inside it;
  // everywhere else the folder being shown is the target.
  const selectedPaths = () => [...state.selectedPaths];
  const targetDirectory = menu !== null && menu.target === 'item' && menu.isDir && menu.path !== null ? menu.path : state.root;

  const menuHandlers: FileExplorerMenuHandlers = {
    open: () => {
      if (menu?.path) handleOpenFile(menu.path);
    },
    newtab: () => {
      if (menu?.path) actions.addTab(workspaceId, menu.path);
    },
    copy: () => {
      copySelection({ sessionId: tab.sessionId, paths: selectedPaths() });
    },
    cut: () => {
      cutSelection({ sessionId: tab.sessionId, paths: selectedPaths() });
    },
    paste: () => {
      pasteFromClipboard({ client: jobClient, target: { destSessionId: tab.sessionId, destPath: targetDirectory } })
        .catch((error: unknown) => showError(`붙여넣지 못했습니다: ${messageOf(error)}`));
    },
    rename: () => {
      const paths = selectedPaths();
      if (paths.length === 1) beginRename(paths[0]);
    },
    delete: () => {
      requestDelete({ client: jobClient, confirm: confirmDelete, selection: { sessionId: tab.sessionId, paths: selectedPaths() } })
        .catch((error: unknown) => showError(`삭제하지 못했습니다: ${messageOf(error)}`));
    },
    newdir: () => {
      void createDirectoryIn(targetDirectory);
    },
    refresh: () => {
      void tree.refresh(targetDirectory);
    },
  };

  const menuItems = menu === null ? [] : buildFileExplorerContextMenuItems({
    target: menu.target,
    isDir: menu.isDir,
    openable: menu.target === 'item' && !menu.isDir && menu.path !== null && isOpenableFile(lastSegment(menu.path)),
    count: state.selectedPaths.size,
    clipboardEmpty: clipboard === null,
    mode: state.mode,
    context: 'explorer-window',
  }, menuHandlers);

  const runShortcut = (action: ShortcutAction) => {
    switch (action.kind) {
      case 'copy': menuHandlers.copy(); break;
      case 'cut': menuHandlers.cut(); break;
      case 'paste': menuHandlers.paste(); break;
      case 'confirm-delete': menuHandlers.delete(); break;
      case 'rename': menuHandlers.rename(); break;
    }
  };

  const commandsRef = useRef<PanelCommands | null>(null);
  useLayoutEffect(() => {
    commandsRef.current = { selectionCount: state.selectedPaths.size, run: runShortcut };
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
      <FileExplorerPathBar tree={tree} setMode={setMode} onNewDirectory={() => void createDirectoryIn(state.root)} />
      <div
        className="fx-scroll"
        ref={scrollRef}
        onScroll={handleScroll}
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
              renaming={rowRename}
            />
          )
          : <FileTreeView tree={tree} clipboard={clipboard} onOpenFile={handleOpenFile} onOpenMenu={setMenu} renaming={rowRename} />}
      </div>
      <FileExplorerConfirmBar prompt={confirmBar.prompt} error={confirmBar.error} onDismissError={confirmBar.dismissError} />
      {isMobile && (
        <FileExplorerMobileBar selectionCount={state.selectedPaths.size} clipboardEmpty={clipboard === null} handlers={menuHandlers} />
      )}
      {menu !== null && (
        <ContextMenu position={{ x: menu.x, y: menu.y }} items={menuItems} onClose={() => setMenu(null)} />
      )}
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

  // Keys go to the panel on screen. Panels register a ref rather than values so
  // the handler reads the selection as it is at the moment of the press.
  const panelCommandsRef = useRef(new Map<string, RefObject<PanelCommands | null>>());
  const activeTabIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    activeTabIdRef.current = activeTab?.id ?? null;
  });
  const registerPanelCommands = useCallback<RegisterPanelCommands>((tabId, commands) => {
    const registry = panelCommandsRef.current;
    registry.set(tabId, commands);
    return () => {
      if (registry.get(tabId) === commands) registry.delete(tabId);
    };
  }, []);

  // Focus is judged by containment in this surface, so a Ctrl+C typed in a
  // terminal never reaches the explorer (DR-16).
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => createFileExplorerShortcutHandler({
    getContext: () => {
      const id = activeTabIdRef.current;
      const commands = id === null ? null : panelCommandsRef.current.get(id)?.current ?? null;
      return {
        focusedInSurface: bodyRef.current?.contains(document.activeElement) ?? false,
        selectionCount: commands?.selectionCount ?? 0,
      };
    },
    run: (action) => {
      const id = activeTabIdRef.current;
      if (id !== null) panelCommandsRef.current.get(id)?.current?.run(action);
    },
  })(event);

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
      {/* Focusable so that a click on a row puts focus inside the surface, which
          is what the shortcut handler checks. */}
      <div className="fx-window-body" ref={bodyRef} tabIndex={-1} onKeyDown={handleKeyDown}>
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
            registerCommands={registerPanelCommands}
          />
        ))}
      </div>
    </WindowDialog>
  );
}
