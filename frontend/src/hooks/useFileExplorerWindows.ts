// The workspace's file explorer windows: at most one per workspace, the same
// shape useEditorWindows keeps its shells in. Every entry point (session path
// menu, terminal menu, header button) goes through openFileExplorer, so a
// repeated request raises the window instead of opening a second one or closing
// it (FR-FEX-003 AC-2, FR-FEX-010 AC-6).
//
// A minimized window keeps its record and stays mounted (design decision 20):
// its surface is hidden, not torn down, so the expanded directories and the
// selection the user left behind are still there when it comes back.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDialogStackEntries, raiseDialogById } from '../components/dialog/dialogStack.ts';
import type { EditorWindowPlacement } from '../components/editor/editorWindowPlacement.ts';
import {
  isEditorWindowVisible,
  type EditorWindowHidingState,
  type EditorWindowScreen,
} from '../components/editor/editorWindowVisibility.ts';
import { decideOpenFileExplorer, fileExplorerDialogId } from '../components/fileExplorer/fileExplorerDialog.ts';
import {
  closeTab as closeExplorerTab,
  dropWindowsOfRemovedWorkspaces,
  openInNewTab,
  removedWorkspaceIds,
  restoreFileExplorerTabs,
  setActiveTab,
  updateTabTree,
  type FileExplorerTab,
  type FileExplorerTabs,
} from '../components/fileExplorer/fileExplorerTabsState.ts';
import {
  decideReviveFileExplorer,
  minimizeFileExplorerRecord,
  restoreFileExplorerRecord,
  toggleFileExplorerMaximize,
} from '../components/fileExplorer/fileExplorerTrayModel.ts';
import type { ListSort } from '../components/fileExplorer/fileListView.ts';
import type { FileTreeMode } from '../components/fileExplorer/fileTreeState.ts';
import type { Workspace, WorkspaceTabRuntime } from '../types/workspace.ts';
import {
  readPersistedFileExplorerState,
  removeFileExplorerStateForWorkspace,
  saveFileExplorerStateForWorkspace,
  type FileExplorerTabRecord,
} from './windowStateStorage.ts';

// The editor's hiding and placement state, so minimize and 최대화 go through
// the editor's own transitions. `floatingRect` stays null: a floating explorer
// window keeps its rect in the dialog's persisted geometry instead.
type FileExplorerWindowRecord = FileExplorerTabs & EditorWindowHidingState;

// Unlike the editor, the explorer does not open into the stage: it is a tool
// window beside the terminal, not a document that wants the whole area.
const NEW_WINDOW_STATE: EditorWindowHidingState = {
  minimized: false,
  placement: 'floating',
  placementBeforeStage: null,
  floatingRect: null,
};

/**
 * A tab as a window renders it: the stored tab plus where it goes when its
 * restored root no longer lists (its session's directory, '' when unknown).
 */
export interface FileExplorerTabView extends FileExplorerTab {
  fallbackRoot: string;
}

/** One window as the layer renders it. */
export interface FileExplorerWindowView {
  workspaceId: string;
  tabs: FileExplorerTabView[];
  activeTabId: string | null;
  minimized: boolean;
  /** 'stage' while maximized over the terminal area. */
  placement: EditorWindowPlacement;
  /** The three-term visibility said no. The surface hides; nothing unmounts. */
  hidden: boolean;
}

export interface OpenFileExplorerRequest {
  workspaceId: string;
  /** The terminal tab the request came from; its cwd is the first tab's root. */
  originTabId: string;
}

/** What a window may do to its own record. */
export interface FileExplorerWindowActions {
  closeFileExplorer: (workspaceId: string) => void;
  minimizeFileExplorer: (workspaceId: string) => void;
  toggleMaximizeFileExplorer: (workspaceId: string) => void;
  selectTab: (workspaceId: string, tabId: string) => void;
  closeTab: (workspaceId: string, tabId: string) => void;
  /** Opens a tab on the active tab's current root and session. */
  addTab: (workspaceId: string, root: string) => void;
  setTabRoot: (workspaceId: string, tabId: string, root: string) => void;
  setTabMode: (workspaceId: string, tabId: string, mode: FileTreeMode) => void;
  setTabSort: (workspaceId: string, tabId: string, sort: ListSort | null) => void;
  setTabAnchor: (workspaceId: string, tabId: string, anchor: string) => void;
}

export interface UseFileExplorerWindowsInput {
  workspaces: readonly Pick<Workspace, 'id' | 'activeTabId'>[];
  tabs: readonly Pick<WorkspaceTabRuntime, 'id' | 'workspaceId' | 'sessionId' | 'cwd'>[];
  resolveTabSession: (tabId: string) => string | undefined;
  screen: EditorWindowScreen;
  activeWorkspaceId: string | null;
  /** Used by a tray row whose window belongs to another workspace. */
  setActiveWorkspaceId: (workspaceId: string) => void;
  /** Used by a tray row chosen while the settings screen is up. */
  setScreen: (screen: EditorWindowScreen) => void;
}

export interface UseFileExplorerWindowsResult extends FileExplorerWindowActions {
  windows: FileExplorerWindowView[];
  openFileExplorer: (request: OpenFileExplorerRequest) => void;
  /** A header tray row: brings the window back, from wherever the user is. */
  reviveFileExplorer: (workspaceId: string) => void;
  /**
   * The callbacks alone, as one object whose identity never changes. A window
   * takes this rather than the whole result: the result changes with every
   * terminal status or cwd flip, which would re-render every memoized panel.
   */
  actions: FileExplorerWindowActions;
}

// Field by field, so a live tab's tree (expanded paths, selection) never reaches
// storage; the storage layer projects the same six fields again on write.
function toTabRecord(tab: FileExplorerTab): FileExplorerTabRecord {
  return {
    id: tab.id,
    originTabId: tab.originTabId,
    root: tab.tree.root,
    mode: tab.tree.mode,
    sort: tab.sort,
    scrollAnchor: tab.scrollAnchor,
  };
}

/**
 * @req FR-FEX-003
 * @req FR-FEX-004
 * @req FR-FEX-010
 */
export function useFileExplorerWindows(input: UseFileExplorerWindowsInput): UseFileExplorerWindowsResult {
  const { workspaces, tabs, resolveTabSession, screen, activeWorkspaceId, setActiveWorkspaceId, setScreen } = input;
  const [windows, setWindows] = useState<Record<string, FileExplorerWindowRecord>>({});

  // Read from callbacks that must see the committed value, not the one captured
  // when the callback was made.
  const windowsRef = useRef(windows);
  const lookupRef = useRef({ workspaces, tabs, resolveTabSession });
  // Revival reads these at the moment of the click, so the callback itself can
  // stay stable instead of changing with every screen or workspace switch.
  const navigationRef = useRef({ screen, activeWorkspaceId, setActiveWorkspaceId, setScreen });
  useEffect(() => {
    windowsRef.current = windows;
    lookupRef.current = { workspaces, tabs, resolveTabSession };
    navigationRef.current = { screen, activeWorkspaceId, setActiveWorkspaceId, setScreen };
  });

  const updateWindow = useCallback((workspaceId: string, change: (record: FileExplorerWindowRecord) => FileExplorerWindowRecord) => {
    setWindows((current) => {
      const record = current[workspaceId];
      if (record === undefined) return current;
      const next = change(record);
      return next === record ? current : { ...current, [workspaceId]: next };
    });
  }, []);

  const openFileExplorer = useCallback((request: OpenFileExplorerRequest) => {
    const { workspaceId, originTabId } = request;
    // The hook's own records count as registered too: a window created in this
    // commit has not mounted its dialog yet, and a second request in the same
    // tick must raise it rather than build it again.
    const registeredDialogIds = [
      ...getDialogStackEntries('modeless').map((entry) => entry.dialogId),
      ...Object.keys(windowsRef.current).map(fileExplorerDialogId),
    ];
    const decision = decideOpenFileExplorer({ registeredDialogIds, workspaceId });

    if (decision.action === 'raise') {
      setWindows((current) => {
        const existing = current[workspaceId];
        if (existing === undefined) return current;
        return { ...current, [workspaceId]: { ...existing, minimized: false } };
      });
      raiseDialogById(decision.dialogId, 'modeless');
      return;
    }

    const lookup = lookupRef.current;
    const activeTabSessionOf = (id: string): string =>
      lookup.resolveTabSession(lookup.workspaces.find((ws) => ws.id === id)?.activeTabId ?? '') ?? '';
    const sessionCwd = (sessionId: string): string =>
      lookup.tabs.find((tab) => tab.sessionId === sessionId)?.cwd ?? '';

    // A stored tab whose terminal tab is gone is re-bound to the workspace's
    // active terminal rather than left without a session.
    const restoredTabs = restoreFileExplorerTabs(readPersistedFileExplorerState(workspaceId), {
      resolveSession: (storedOriginTabId) => lookup.resolveTabSession(storedOriginTabId) ?? activeTabSessionOf(workspaceId),
      sessionCwd,
    });
    // A tab re-bound to the active terminal takes that terminal as its origin
    // too, or it would keep following a tab that is gone: a restart would not
    // reach it, and a file it opens would be bound to nothing. A tab that found
    // no session at all cannot list anything and is dropped.
    const activeTabId = lookup.workspaces.find((ws) => ws.id === workspaceId)?.activeTabId ?? '';
    const reboundTabs = restoredTabs.tabs
      .filter((tab) => tab.sessionId !== '')
      .map((tab) => (lookup.resolveTabSession(tab.originTabId) === undefined ? { ...tab, originTabId: activeTabId } : tab));
    const restored: FileExplorerTabs = {
      tabs: reboundTabs,
      activeTabId: reboundTabs.some((tab) => tab.id === restoredTabs.activeTabId)
        ? restoredTabs.activeTabId
        : (reboundTabs[0]?.id ?? null),
    };

    let initial: FileExplorerTabs = restored;
    if (restored.tabs.length === 0) {
      const sessionId = lookup.resolveTabSession(originTabId) ?? activeTabSessionOf(workspaceId);
      const root = sessionCwd(sessionId);
      // Nothing to list without a session or a directory to start in.
      if (sessionId === '' || root === '') return;
      initial = openInNewTab(restored, { sessionId, path: root, originTabId });
    }

    // A window created by an earlier request of the same tick is kept: the
    // registered-id check above could not see it before its commit.
    setWindows((current) => (current[workspaceId] !== undefined
      ? current
      : { ...current, [workspaceId]: { ...initial, ...NEW_WINDOW_STATE } }));
  }, []);

  const closeFileExplorer = useCallback((workspaceId: string) => {
    setWindows((current) => {
      if (current[workspaceId] === undefined) return current;
      const next = { ...current };
      delete next[workspaceId];
      return next;
    });
  }, []);

  // Only the hiding flag changes; the record keeps its tabs, whose trees hold
  // the expanded directories and selection, as the same references.
  const minimizeFileExplorer = useCallback((workspaceId: string) => {
    updateWindow(workspaceId, (record) => (record.minimized ? record : minimizeFileExplorerRecord(record)));
  }, [updateWindow]);

  const toggleMaximizeFileExplorer = useCallback((workspaceId: string) => {
    updateWindow(workspaceId, (record) => toggleFileExplorerMaximize(record));
  }, [updateWindow]);

  // A tray row reaches the window from any workspace and from the settings
  // screen, so un-hiding alone is not enough: the window is only visible once
  // its workspace is active and the workspace screen is up.
  //
  // The navigation happens even when the workspace has no window left: the
  // status bar's 응답 대기 button revives first and then opens the window
  // (App.tsx), and the window must open where the user can see it.
  const reviveFileExplorer = useCallback((workspaceId: string) => {
    const navigation = navigationRef.current;
    const decision = decideReviveFileExplorer({
      workspaceId,
      activeWorkspaceId: navigation.activeWorkspaceId,
      screen: navigation.screen,
    });
    if (decision.showWorkspaceScreen) navigation.setScreen('workspace');
    if (decision.switchWorkspaceId !== null) navigation.setActiveWorkspaceId(decision.switchWorkspaceId);
    updateWindow(workspaceId, (record) => (record.minimized ? restoreFileExplorerRecord(record) : record));
    raiseDialogById(decision.raiseDialogId, 'modeless');
  }, [updateWindow]);

  const selectTab = useCallback((workspaceId: string, tabId: string) => {
    updateWindow(workspaceId, (record) => {
      const next = setActiveTab(record, tabId);
      return next === record ? record : { ...record, ...next };
    });
  }, [updateWindow]);

  // Closing the last tab closes the window: an explorer with no tab has nothing
  // to show and no root to add a tab at.
  const closeTab = useCallback((workspaceId: string, tabId: string) => {
    // The window record goes with its last tab, and the save effect only writes
    // records that exist, so the emptied list is written here: otherwise the
    // tab the user closed would come back on the next open.
    const committed = windowsRef.current[workspaceId];
    if (committed !== undefined && committed.tabs.length === 1 && committed.tabs[0].id === tabId) {
      saveFileExplorerStateForWorkspace(workspaceId, { tabs: [], activeTabId: null });
    }
    setWindows((current) => {
      const record = current[workspaceId];
      if (record === undefined) return current;
      const next = closeExplorerTab(record, tabId);
      if (next === record) return current;
      if (next.tabs.length === 0) {
        const rest = { ...current };
        delete rest[workspaceId];
        return rest;
      }
      return { ...current, [workspaceId]: { ...record, ...next } };
    });
  }, []);

  const addTab = useCallback((workspaceId: string, root: string) => {
    updateWindow(workspaceId, (record) => {
      const active = record.tabs.find((tab) => tab.id === record.activeTabId) ?? record.tabs[0];
      if (active === undefined) return record;
      const next = openInNewTab(record, { sessionId: active.sessionId, path: root, originTabId: active.originTabId });
      return { ...record, ...next };
    });
  }, [updateWindow]);

  const setTabRoot = useCallback((workspaceId: string, tabId: string, root: string) => {
    updateWindow(workspaceId, (record) => {
      const next = updateTabTree(record, tabId, { type: 'SET_ROOT', path: root });
      // A new root has a new top row; the old anchor names a row that is not there.
      return next === record ? record : { ...record, tabs: next.tabs.map((tab) => (tab.id === tabId ? { ...tab, scrollAnchor: null } : tab)) };
    });
  }, [updateWindow]);

  const setTabMode = useCallback((workspaceId: string, tabId: string, mode: FileTreeMode) => {
    updateWindow(workspaceId, (record) => {
      const next = updateTabTree(record, tabId, { type: 'SET_MODE', mode });
      return next === record ? record : { ...record, ...next };
    });
  }, [updateWindow]);

  const updateTab = useCallback((workspaceId: string, tabId: string, change: (tab: FileExplorerTab) => FileExplorerTab) => {
    updateWindow(workspaceId, (record) => {
      let changed = false;
      const nextTabs = record.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const updated = change(tab);
        if (updated !== tab) changed = true;
        return updated;
      });
      return changed ? { ...record, tabs: nextTabs } : record;
    });
  }, [updateWindow]);

  const setTabSort = useCallback((workspaceId: string, tabId: string, sort: ListSort | null) => {
    updateTab(workspaceId, tabId, (tab) => ({ ...tab, sort }));
  }, [updateTab]);

  const setTabAnchor = useCallback((workspaceId: string, tabId: string, anchor: string) => {
    updateTab(workspaceId, tabId, (tab) => (tab.scrollAnchor === anchor ? tab : { ...tab, scrollAnchor: anchor }));
  }, [updateTab]);

  // Every change to a window's tabs -- mode, sort, anchor, root, the tab list
  // itself -- is written once it commits. Only windows whose record changed are
  // written, and a closed window's stored tabs stay for the next open.
  const savedRef = useRef<Record<string, FileExplorerWindowRecord>>({});
  useEffect(() => {
    for (const [workspaceId, record] of Object.entries(windows)) {
      if (savedRef.current[workspaceId] === record) continue;
      saveFileExplorerStateForWorkspace(workspaceId, {
        tabs: record.tabs.map(toTabRecord),
        activeTabId: record.activeTabId,
      });
    }
    savedRef.current = windows;
  }, [windows]);

  // A deleted workspace takes its window and its stored tabs with it; otherwise
  // the record would stay mounted for a workspace nobody can reach, and its
  // tabs would come back if the id were ever seen again.
  // Decided on the committed records (the ref is set by the effect above, which
  // runs first), because a state updater runs later and could not report what
  // it removed in time to clear storage.
  // A workspace whose explorer was closed has no record but may still have
  // stored tabs, so its key is cleared from the id list's own diff as well.
  const previousWorkspaceIdsRef = useRef<readonly string[]>([]);
  useEffect(() => {
    const liveIds = workspaces.map((workspace) => workspace.id);
    const gone = removedWorkspaceIds(previousWorkspaceIdsRef.current, liveIds);
    // An empty list is "not loaded"; keeping the last loaded one lets the diff
    // see a deletion that arrives after it.
    if (liveIds.length > 0) previousWorkspaceIdsRef.current = liveIds;
    const { removed } = dropWindowsOfRemovedWorkspaces(windowsRef.current, liveIds);
    if (removed.length > 0) setWindows((current) => dropWindowsOfRemovedWorkspaces(current, liveIds).windows);
    for (const workspaceId of new Set([...removed, ...gone])) removeFileExplorerStateForWorkspace(workspaceId);
  }, [workspaces]);

  const viewCacheRef = useRef(new WeakMap<FileExplorerTab, FileExplorerTabView>());
  const views = useMemo<FileExplorerWindowView[]>(() => Object.entries(windows).map(([workspaceId, record]) => ({
    workspaceId,
    // The session a terminal tab runs changes on restart while the tab stays,
    // so it is looked up at render rather than kept from when the tab opened.
    tabs: record.tabs.map((tab): FileExplorerTabView => {
      const sessionId = resolveTabSession(tab.originTabId) ?? tab.sessionId;
      const fallbackRoot = tabs.find((terminal) => terminal.sessionId === sessionId)?.cwd ?? '';
      // The same object while nothing about this tab changed, so a memoized
      // panel of one tab does not re-render when another tab scrolls.
      const cached = viewCacheRef.current.get(tab);
      if (cached !== undefined && cached.sessionId === sessionId && cached.fallbackRoot === fallbackRoot) return cached;
      const view = { ...tab, sessionId, fallbackRoot };
      viewCacheRef.current.set(tab, view);
      return view;
    }),
    activeTabId: record.activeTabId,
    minimized: record.minimized,
    placement: record.placement,
    hidden: !isEditorWindowVisible({
      minimized: record.minimized,
      screen,
      activeWorkspaceId,
      windowWorkspaceId: workspaceId,
    }),
  })), [windows, resolveTabSession, tabs, screen, activeWorkspaceId]);

  // Built from the callbacks only, every one of which is itself stable, so this
  // object keeps its identity across tab, screen and cwd changes and a memoized
  // panel that takes it does not re-render for them.
  const actions = useMemo<FileExplorerWindowActions>(() => ({
    closeFileExplorer,
    minimizeFileExplorer,
    toggleMaximizeFileExplorer,
    selectTab,
    closeTab,
    addTab,
    setTabRoot,
    setTabMode,
    setTabSort,
    setTabAnchor,
  }), [closeFileExplorer, minimizeFileExplorer, toggleMaximizeFileExplorer, selectTab, closeTab, addTab, setTabRoot, setTabMode, setTabSort, setTabAnchor]);

  return useMemo(() => ({
    ...actions,
    actions,
    windows: views,
    openFileExplorer,
    reviveFileExplorer,
  }), [actions, views, openFileExplorer, reviveFileExplorer]);
}
