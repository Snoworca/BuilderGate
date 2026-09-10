// The open editor windows, the path context menu that creates them and the
// header tray that lists them, held in one place so that `AppContent` carries
// the wiring rather than the rules.
//
// Every decision this hook makes is delegated: the menu items, the duplicate
// key, the anchor tab and what a failed read means to `editorFileMenu`; the
// tray scope and the revival to `editorTrayModel`; the placement transitions to
// `editorWindowPlacement`. What is left here is React state and the order the
// steps run in, which is exactly the part this repository's frontend suite
// cannot test -- there is no DOM environment and no renderer.
//
// The window rect is deliberately absent from the decisions above. It is
// computed by `EditorWindowLayer`, which is the only place that knows the
// terminal host registry and every window at once, and it is never stored here.
// The one rect this hook does hold is the one a drag produced, which arrives
// through `updateWindowRect` and is what a `floating` window floats at.
//
// @req FR-MDE-007
// @req FR-MDE-008

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContextMenuItem } from '../components/ContextMenu/ContextMenu';
import type { DialogRect } from '../components/dialog/types';
import {
  toEditorWindowRecord,
  type EditorWindowRecord,
} from '../components/editor/editorWindowRecord.ts';
import type { UseWindowStateResult } from './useWindowState.ts';
import {
  createEditorWindowPlacementState,
  enterFloating,
  toggleMaximize,
  type EditorWindowPlacement,
} from '../components/editor/editorWindowPlacement.ts';
import { raiseDialogById } from '../components/dialog/dialogStack.ts';
import {
  EDITOR_WINDOW_MIN_SIZE,
  editorWindowDialogId,
} from '../components/editor/EditorWindow.tsx';
import { computeInitialEditorWindowRect } from '../components/editor/editorWindowInitialRect.ts';
import {
  minimizeEditorWindow,
  type EditorWindowScreen,
  type EditorWindowViewMode,
} from '../components/editor/editorWindowVisibility.ts';
import {
  countMinimizedEditorTrayWindows,
  hasEditorTrayWindows,
  listEditorTrayEntries,
  reviveEditorTrayWindow,
  type EditorTrayWindow,
} from '../components/editor/editorTrayModel.ts';
import {
  buildEditorFileMenuItems,
  isMissingFileError,
  selectEditorPathMenuTab,
  type EditorFileMenuSelection,
} from '../utils/editorFileMenu.ts';
import { fileApi } from '../services/api';

/**
 * An open editor window. The tray reads every field of `EditorTrayWindow`, the
 * window layer additionally reads the placement and the rect, and the window
 * itself reads the body -- so one record serves all three rather than three
 * lists that could drift apart.
 * @req FR-MDE-007
 * @req FR-MDE-008
 */
export type EditorWindowState = EditorTrayWindow & {
  placement: EditorWindowPlacement;
  /** The placement recorded on entry to `stage`, or null when none was. */
  placementBeforeStage: EditorWindowPlacement | null;
  /** Where a `floating` window floats. Null until it has been dragged. */
  floatingRect: DialogRect | null;
  /** The content read from disk when the window opened. Never fed back. */
  bodyAtOpen: string;
  /** Creation order, which is also the order the layer mounts them in. */
  stackOrder: number;
};

/** Where the path context menu was opened, and which tab's path it was. */
export interface EditorPathMenuAnchor {
  x: number;
  y: number;
  tabId: string;
}

/** A file that is not there yet, and the tab that asked for it. */
export interface EditorCreatePrompt {
  filePath: string;
  tabId: string;
}

/**
 * The app state the visibility rules read. It is passed in rather than reached
 * for, so this hook holds no opinion about where a screen or a tab comes from.
 */
export interface UseEditorWindowsInput {
  screen: EditorWindowScreen;
  setScreen: (screen: EditorWindowScreen) => void;
  /** The mode the workspace is rendered in, not necessarily the stored one. */
  viewMode: EditorWindowViewMode;
  activeWorkspaceId: string | null;
  activeTabId: string | null;
  /** Only the id and the displayed cwd are read, so the workspace type stays out. */
  tabs: readonly { id: string; cwd: string }[];
  onSelectTab: (tabId: string) => void;
  /**
   * The session a tab is running at the moment of the call. Resolved per call
   * rather than stored, because a restart replaces the session and keeps the
   * tab -- a stored id would be stale from the first restart onwards.
   */
  resolveTabSession: (tabId: string) => string | undefined;
  /**
   * The ids of the tabs belonging to the active workspace, which is the set a
   * restore filters its stored records against. Narrower than `tabs`, which the
   * path menu reads and which spans every workspace: a record whose tab has
   * moved to another workspace still names a live tab, but not one that exists
   * here, and restoring it would put a window over a terminal that is not here.
   * @req FR-MDE-009
   */
  activeWorkspaceTabIds: readonly string[];
  /**
   * The per-workspace window store, already bound to a workspace by the caller.
   * It is handed in rather than opened here because the binding is a decision
   * about which workspace is active, and that decision is already made one
   * level up -- making it twice would let the two answers differ.
   * @req FR-MDE-009
   */
  windowState: UseWindowStateResult;
}

export interface UseEditorWindowsResult {
  /** In creation order, which is the order the window layer mounts them in. */
  windows: EditorWindowState[];
  /** Whether the tray icon renders. Scoped exactly as the list is. */
  hasWindows: boolean;
  /** How many of them are minimized, which the tray icon carries as a badge. */
  minimizedCount: number;
  trayItems: ContextMenuItem[];
  pathMenu: EditorPathMenuAnchor | null;
  pathMenuItems: ContextMenuItem[];
  openPathMenu: (x: number, y: number, tabId: string) => void;
  closePathMenu: () => void;
  /** The 404 question, or null when none is being asked. */
  createPrompt: EditorCreatePrompt | null;
  confirmCreate: () => void;
  cancelCreate: () => void;
  /** A read failure that is not a 404, or null when none is being reported. */
  openError: string | null;
  dismissOpenError: () => void;
  updateWindowRect: (filePath: string, rect: DialogRect) => void;
  /** The window's document started, or stopped, differing from the file. */
  setWindowDirty: (filePath: string, dirty: boolean) => void;
  /** The bound tab has gone; the window becomes floating at `rect`. */
  orphanWindow: (filePath: string, rect: DialogRect) => void;
  closeWindow: (filePath: string) => void;
  minimizeWindow: (filePath: string) => void;
  toggleMaximizeWindow: (filePath: string) => void;
  writeFile: (sessionId: string, path: string, content: string) => Promise<{ success: boolean }>;
  /**
   * The windows a restore just created, or null when none is waiting. They have
   * to be raised into their stored order once they have mounted, and only the
   * layer knows when that has happened -- a window that has not registered yet
   * is not in the modeless stack and cannot be raised.
   * @req FR-MDE-009
   */
  pendingStackRestore: readonly EditorWindowRecord[] | null;
  /** The layer has finished raising them. */
  clearPendingStackRestore: () => void;
}

/**
 * @req FR-MDE-007
 * @req FR-MDE-008
 */
export function useEditorWindows(input: UseEditorWindowsInput): UseEditorWindowsResult {
  const {
    screen,
    setScreen,
    viewMode,
    activeWorkspaceId,
    activeTabId,
    tabs,
    onSelectTab,
    resolveTabSession,
    activeWorkspaceTabIds,
    windowState,
  } = input;
  const { restoreWindows, saveWindows } = windowState;

  // FR-MDE-007's path menu is one of the two things that creates a window; the
  // other is FR-MDE-009's restore, below.
  const [windows, setWindows] = useState<EditorWindowState[]>([]);
  const [pathMenu, setPathMenu] = useState<EditorPathMenuAnchor | null>(null);
  const [createPrompt, setCreatePrompt] = useState<EditorCreatePrompt | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  // Monotonic, so a window that closes does not hand its number to the next
  // one. Creation order is what the layer mounts in, and two windows sharing a
  // number would make that order depend on which of them React saw first.
  const nextStackOrder = useRef(0);
  // Which workspaces this page load has already read the store for. The read
  // happens once per workspace and never again: leaving a workspace does not
  // unmount its windows, so coming back finds the unsaved bodies still in
  // memory, and reading the store again would rebuild them from disk and throw
  // that work away. Writing is gated on the same set, so nothing is written to
  // a workspace's key before its stored value has been read.
  // @req FR-MDE-009
  const restoreStartedRef = useRef(new Set<string>());
  // Per workspace, the records that have been read from the store but have not
  // become windows yet -- still loading, or their file could not be read. They
  // are written back alongside the live windows so that a save landing in that
  // interval does not erase them.
  // @req FR-MDE-009
  const pendingRestoreRef = useRef(new Map<string, EditorWindowRecord[]>());
  const [pendingStackRestore, setPendingStackRestore] = useState<EditorWindowRecord[] | null>(null);
  // The session lookup as it is right now. The restore reads it per file rather
  // than closing over it, for the reason this hook resolves sessions per call
  // everywhere else: a restart replaces the session and keeps the tab.
  const resolveTabSessionRef = useRef(resolveTabSession);
  // The committed window list, for the restore to compare against once its
  // reads have finished. The list it captured when the effect ran was the one
  // before any of them landed.
  const windowsRef = useRef(windows);
  // Assigned after the commit rather than during the render. A render body runs
  // for renders React then throws away, so a ref written there can hold a value
  // that was never committed -- and the restore reads these from an async
  // continuation, where "the latest render" and "what is on screen" differ.
  // Declared above the effects that read them so it runs first in each commit.
  useEffect(() => {
    resolveTabSessionRef.current = resolveTabSession;
    windowsRef.current = windows;
  });

  /**
   * Drops a path from every workspace's pending list. A pending record is one
   * the store holds and this page load has not turned into a window yet; once
   * it has become one -- restored, or opened by hand -- it stops being carried,
   * so that closing that window removes it from the store rather than leaving
   * the pending copy to bring it back on the next load.
   *
   * Every workspace, not just the one the window landed in, because a window's
   * identity is its path and only one window per path can be open at a time.
   * A record left behind in another workspace could never be restored -- the
   * path already belongs to a window elsewhere -- and would be written back on
   * every save for the rest of the session.
   * @req FR-MDE-009
   */
  const forgetPendingRestore = useCallback((filePath: string) => {
    pendingRestoreRef.current.forEach((pending, workspaceId) => {
      const next = pending.filter(record => record.filePath !== filePath);
      if (next.length !== pending.length) pendingRestoreRef.current.set(workspaceId, next);
    });
  }, []);

  // One revival, shared. FR-MDE-007 uses it when the file it was asked for is
  // already open, and FR-MDE-008 uses it when a tray entry is chosen. Clearing
  // `minimized` alone would leave the window behind the settings screen or an
  // inactive tab, with nothing happening on screen.
  const revive = useCallback((target: EditorWindowState) => {
    const revival = reviveEditorTrayWindow({
      target,
      windows,
      screen,
      viewMode,
      activeTabId,
    });

    setScreen(revival.screen);
    setWindows(revival.windows);
    // A tab that still exists, or none. The tray lists a window whose tab has
    // closed -- that is the point of it -- and the revival names that window's
    // tab as the one to switch to. Selecting it would leave the workspace
    // pointing at nothing: the terminal area goes blank and every other window
    // in that workspace fails the tab term and disappears, carrying bodies
    // nobody has saved off the screen. The orphan itself needs no switch; it is
    // exempt from that term already.
    // @req CON-MDE-002
    if (revival.activeTabId !== null
      && revival.activeTabId !== activeTabId
      && resolveTabSession(revival.activeTabId) !== undefined) {
      onSelectTab(revival.activeTabId);
    }
    // The revived window comes to the front. Front-to-back order lives in the
    // modeless stack rather than in these records, so that is where the raise
    // lands.
    raiseDialogById(editorWindowDialogId(revival.raise), 'modeless');
  }, [activeTabId, onSelectTab, resolveTabSession, screen, setScreen, viewMode, windows]);

  const reviveByPath = useCallback((filePath: string) => {
    const target = windows.find(editorWindow => editorWindow.filePath === filePath);
    if (target) revive(target);
  }, [revive, windows]);

  const openPathMenu = useCallback((x: number, y: number, tabId: string) => {
    setPathMenu({ x, y, tabId });
  }, []);

  const closePathMenu = useCallback(() => {
    setPathMenu(null);
  }, []);

  /**
   * Adds the window and hands the body to it. The workspace is read here rather
   * than stored on the selection because a window belongs to the workspace it
   * was opened in, and that is the active one at this moment.
   * @req FR-MDE-007
   */
  const addWindow = useCallback((filePath: string, tabId: string, bodyAtOpen: string) => {
    if (activeWorkspaceId === null) return;

    // This path is a window now, so the store no longer needs the restore to
    // carry its stored record: closing this window must remove it.
    // @req FR-MDE-009
    forgetPendingRestore(filePath);

    setWindows((current) => {
      if (current.some(editorWindow => editorWindow.filePath === filePath)) {
        return current;
      }
      const stackOrder = nextStackOrder.current;
      nextStackOrder.current += 1;

      // A window opens floating at seven tenths of the viewport rather than
      // filling the stage. Filling it would put the window over the terminal's
      // own path bar and over every window already open, which is exactly what
      // one window per document used to avoid by covering only its own
      // terminal.
      //
      // The viewport is measured here rather than inside the rule, so the rule
      // stays decidable without a browser. The guard is not defensive padding:
      // suites run this module with no DOM installed, where a bare `window` is
      // a ReferenceError rather than an absent value.
      const measured = typeof window === 'undefined'
        ? { width: 0, height: 0 }
        : { width: window.innerWidth, height: window.innerHeight };
      const initialRect = computeInitialEditorWindowRect(measured, EDITOR_WINDOW_MIN_SIZE);

      return [...current, {
        ...enterFloating(createEditorWindowPlacementState(), initialRect),
        filePath,
        tabId,
        workspaceId: activeWorkspaceId,
        minimized: false,
        // A window opens on the body it just read, so it starts clean. The
        // window reports every change to this through `setWindowDirty`.
        dirty: false,
        bodyAtOpen,
        stackOrder,
      }];
    });

    // Reopening a file that is already open raises the window that is there
    // instead of adding a second one, which is what the guard above leaves to
    // be done. A window being created for the first time has not registered
    // yet, so this finds nothing and says so -- which is right: it enters the
    // stack last and is already in front.
    // @req FR-MDE-007
    raiseDialogById(editorWindowDialogId(filePath), 'modeless');
  }, [activeWorkspaceId, forgetPendingRestore]);

  /**
   * The read, and the three answers it can give. A window is opened only on
   * success or after the user agrees to create the file -- never on an error
   * whose cause is unknown, because the body it would open on is unknown too.
   * @req FR-MDE-007
   */
  const openWindow = useCallback(async (filePath: string, tabId: string) => {
    const sessionId = resolveTabSession(tabId);
    if (sessionId === undefined) {
      setOpenError('세션을 찾을 수 없어 파일을 열지 못했습니다.');
      return;
    }

    try {
      const file = await fileApi.readFile(sessionId, filePath);
      addWindow(filePath, tabId, file.content);
    } catch (error) {
      if (isMissingFileError(error)) {
        setCreatePrompt({ filePath, tabId });
        return;
      }
      setOpenError(error instanceof Error ? error.message : String(error));
    }
  }, [addWindow, resolveTabSession]);

  /**
   * The answer to the 404 question. The file is created empty and the window
   * opens on that same empty body, so nothing is read back -- the write is the
   * document's whole history at this point.
   * @req FR-MDE-007
   */
  const confirmCreate = useCallback(() => {
    const prompt = createPrompt;
    setCreatePrompt(null);
    if (prompt === null) return;

    const sessionId = resolveTabSession(prompt.tabId);
    if (sessionId === undefined) {
      setOpenError('세션을 찾을 수 없어 파일을 만들지 못했습니다.');
      return;
    }

    void fileApi.writeFile(sessionId, prompt.filePath, '')
      .then(() => addWindow(prompt.filePath, prompt.tabId, ''))
      .catch((error: unknown) => {
        setOpenError(error instanceof Error ? error.message : String(error));
      });
  }, [addWindow, createPrompt, resolveTabSession]);

  const cancelCreate = useCallback(() => {
    setCreatePrompt(null);
  }, []);

  const dismissOpenError = useCallback(() => {
    setOpenError(null);
  }, []);

  const handleSelect = useCallback((selection: EditorFileMenuSelection) => {
    setPathMenu(null);

    if (selection.kind === 'revive') {
      reviveByPath(selection.filePath);
      return;
    }

    void openWindow(selection.filePath, selection.tabId);
  }, [openWindow, reviveByPath]);

  // The items are built from the menu's own anchor rather than from the active
  // tab: a right click in grid mode targets a tile that is not the active one.
  const pathMenuItems = useMemo(() => {
    if (pathMenu === null) return [];
    const targetTab = selectEditorPathMenuTab(tabs, pathMenu.tabId);
    if (targetTab === null) return [];

    return buildEditorFileMenuItems({
      cwd: targetTab.cwd,
      tabId: targetTab.id,
      openWindows: windows,
      onSelect: handleSelect,
    });
  }, [handleSelect, pathMenu, tabs, windows]);

  const trayItems = useMemo<ContextMenuItem[]>(
    () => listEditorTrayEntries(windows, activeWorkspaceId).map(entry => ({
      label: entry.label,
      // The rows carry absolute paths, which are long. The class is what lets
      // the menu set a smaller type for them without shrinking every other
      // context menu in the application.
      className: 'editor-tray-item',
      onClick: () => reviveByPath(entry.filePath),
    })),
    [activeWorkspaceId, reviveByPath, windows],
  );

  /**
   * Applies one change to the window holding `filePath` and leaves the rest
   * alone. Every window operation below goes through it, so the identity rule
   * -- the resolved absolute path -- is stated once.
   * @req FR-MDE-001
   */
  const updateWindow = useCallback((
    filePath: string,
    change: (editorWindow: EditorWindowState) => EditorWindowState,
  ) => {
    setWindows((current) => {
      const next = current.map(editorWindow => (
        editorWindow.filePath === filePath ? change(editorWindow) : editorWindow
      ));

      // The same list when nothing moved, so a change that decides to keep the
      // record it was given does not cost a render.
      return next.every((editorWindow, index) => editorWindow === current[index])
        ? current
        : next;
    });
  }, []);

  /**
   * A rect the user produced. `WindowDialog` emits this from its drag and
   * resize handlers only -- a controlled rect never round-trips through it --
   * so an arrival here means the window was moved by hand, and that is what
   * turns it `floating`. The placement follows the interaction rather than a
   * control, which is why no button sets it.
   * @req FR-MDE-001
   */
  const updateWindowRect = useCallback((filePath: string, rect: DialogRect) => {
    updateWindow(filePath, editorWindow => ({ ...editorWindow, ...enterFloating(editorWindow, rect) }));
  }, [updateWindow]);

  /**
   * The window's document has diverged from the file, or has stopped diverging.
   *
   * The save controller lives inside the window and is the only thing that
   * knows this, so the record it feeds cannot work it out for itself -- it
   * would have to hold a second copy of the body to do so. Reported instead,
   * which is what lets the tray mark the entry.
   *
   * The record is returned unchanged when the flag already matches. Without
   * that, the window reports on every render and every report allocates a new
   * list, which is a re-render that produces the next report.
   * @req FR-MDE-008
   */
  const setWindowDirty = useCallback((filePath: string, dirty: boolean) => {
    updateWindow(filePath, editorWindow => (
      editorWindow.dirty === dirty ? editorWindow : { ...editorWindow, dirty }
    ));
  }, [updateWindow]);

  /**
   * The bound tab has gone, so the window becomes floating at the rectangle it
   * was occupying. This is a state transition rather than a way of drawing it:
   * the record is what `App` reads to decide which boundary the window drags
   * against, so a window drawn as floating while its record said otherwise
   * would answer two different ways about itself.
   *
   * It goes through `enterFloating` like every other route into that state, so
   * there is one place that knows what entering it means.
   * @req CON-MDE-002
   */
  const orphanWindow = useCallback((filePath: string, rect: DialogRect) => {
    updateWindow(filePath, editorWindow => (
      editorWindow.placement === 'floating'
        ? editorWindow
        : { ...editorWindow, ...enterFloating(editorWindow, rect) }
    ));
  }, [updateWindow]);

  const closeWindow = useCallback((filePath: string) => {
    setWindows(current => current.filter(editorWindow => editorWindow.filePath !== filePath));
  }, []);

  const minimizeWindow = useCallback((filePath: string) => {
    updateWindow(filePath, editorWindow => ({
      ...editorWindow,
      ...minimizeEditorWindow(editorWindow),
    }));
  }, [updateWindow]);

  const toggleMaximizeWindow = useCallback((filePath: string) => {
    updateWindow(filePath, editorWindow => ({ ...editorWindow, ...toggleMaximize(editorWindow) }));
  }, [updateWindow]);

  /**
   * Rebuilds a workspace's windows from the store, once per page load.
   *
   * The body is not in the store and is read from disk here, which is what
   * makes this asynchronous: the store holds placement, and the document comes
   * from the file as it is now. A file that cannot be read leaves its window
   * unrestored and says nothing -- the user did not ask for this read and has
   * no action to take on it, which is the same reason a missing or malformed
   * stored value is silent.
   *
   * An unrestored record is **not** dropped from the store. A read fails for
   * reasons that pass -- a session that has not come up yet, a network blip --
   * and writing the successful subset back would turn a moment's trouble into
   * the permanent loss of a layout the user never asked to change. The records
   * still waiting are therefore carried into every write below until they
   * become windows.
   *
   * The tab list is waited for, and it is the tab list of the workspace being
   * restored. Every stored record names a tab, so restoring against an empty
   * list would drop all of them; restoring against every workspace's tabs would
   * keep a record whose tab has moved elsewhere, and that window would have no
   * terminal here to dock to.
   * @req FR-MDE-009
   */
  const tabIdsKey = activeWorkspaceTabIds.join(',');
  useEffect(() => {
    const workspaceId = activeWorkspaceId;
    if (workspaceId === null
      || tabIdsKey === ''
      || restoreStartedRef.current.has(workspaceId)) {
      return;
    }
    restoreStartedRef.current.add(workspaceId);

    const records = restoreWindows(activeWorkspaceTabIds);
    // Held before the first read, so a write that happens while the reads are
    // still running carries them and nothing is lost. They leave this list one
    // at a time as their windows appear.
    pendingRestoreRef.current.set(workspaceId, records);
    // Moved past every stored number now rather than after the reads: the user
    // can open a window while they are in flight, and a counter still at zero
    // would hand it a number a restored window already holds.
    records.forEach((record) => {
      nextStackOrder.current = Math.max(nextStackOrder.current, record.stackOrder + 1);
    });
    if (records.length === 0) return;

    // Deliberately not cancelled when this effect re-runs. `activeWorkspaceTabIds`
    // is rebuilt on every render, so a cleanup that aborted the reads would abort
    // them on the very next render -- and the guard above would then refuse to
    // start again, leaving the workspace permanently unrestored. Finishing is
    // also the right answer on a workspace switch: these windows belong to the
    // workspace they were read for, and the list holds every workspace's at once.
    void (async () => {
      const restored: EditorWindowState[] = [];
      for (const record of records) {
        // Resolved through the ref rather than the captured lookup: a tab
        // restart keeps the tab id and replaces the session, and a lookup
        // captured when this effect ran would keep handing out the dead one.
        const sessionId = resolveTabSessionRef.current(record.tabId);
        if (sessionId === undefined) continue;

        try {
          const file = await fileApi.readFile(sessionId, record.filePath);
          restored.push({
            ...record,
            workspaceId,
            dirty: false,
            bodyAtOpen: file.content,
          });
        } catch {
          // The file is gone or unreadable. The record stays pending, so the
          // store keeps it and a later page load can try again.
        }
      }

      // A window the user opened by hand while the reads were in flight wins:
      // it is the same file and it already holds the body they are looking at.
      //
      // The comparison reads the committed list through a ref rather than from
      // inside the `setWindows` updater. React does not promise to run an
      // updater at the moment it is dispatched -- with another update already
      // pending on this component it is deferred to the render phase -- so a
      // value computed in there and read afterwards would still be empty, and
      // the stack restore below would be skipped without anything failing.
      const alreadyOpen = new Set(windowsRef.current.map(editorWindow => editorWindow.filePath));
      const added = restored.filter(editorWindow => !alreadyOpen.has(editorWindow.filePath));

      if (added.length > 0) {
        // The updater still checks for itself. `added` was decided against the
        // last committed list, and a window opened between that commit and this
        // dispatch would otherwise be added a second time under the same path.
        setWindows((current) => {
          const open = new Set(current.map(editorWindow => editorWindow.filePath));
          return [...current, ...added.filter(editorWindow => !open.has(editorWindow.filePath))];
        });
        added.forEach(editorWindow => forgetPendingRestore(editorWindow.filePath));
        setPendingStackRestore(added.map(editorWindow => toEditorWindowRecord(editorWindow)));
      }
    })();
    // `activeWorkspaceTabIds` is a fresh array on every render, so the identity
    // of the tab set is what this depends on rather than the array itself --
    // the same reason `useMosaicLayout` keys its reload on a joined id list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId, tabIdsKey]);

  /**
   * Writes the active workspace's windows after every change to them. One write
   * per change rather than a debounced one, because a rect arrives from
   * `WindowDialog` when a drag ends rather than while it moves.
   *
   * Records still waiting to be restored are written alongside the live
   * windows, so a write that lands mid-restore preserves what has not been
   * rebuilt yet. A window whose tab has closed is still a window and is still
   * written -- the tray lists it and the user may yet save it elsewhere -- so
   * its entry names a tab that is gone; the next page load's restore is what
   * drops it, because the tab filter refuses it and the first save afterwards
   * writes without it.
   *
   * Windows of other workspaces are filtered out rather than written under this
   * key: the store is per workspace, and an entry naming a tab from elsewhere
   * would name nothing in the workspace it was restored into.
   * @req FR-MDE-009
   */
  useEffect(() => {
    const workspaceId = activeWorkspaceId;
    if (workspaceId === null || !restoreStartedRef.current.has(workspaceId)) return;

    const own = windows.filter(editorWindow => editorWindow.workspaceId === workspaceId);
    const openPaths = new Set(own.map(editorWindow => editorWindow.filePath));
    const stillPending = (pendingRestoreRef.current.get(workspaceId) ?? [])
      .filter(record => !openPaths.has(record.filePath));

    saveWindows([...own, ...stillPending]);
  }, [activeWorkspaceId, saveWindows, windows]);

  const clearPendingStackRestore = useCallback(() => {
    setPendingStackRestore(null);
  }, []);

  return {
    windows,
    hasWindows: hasEditorTrayWindows(windows, activeWorkspaceId),
    minimizedCount: countMinimizedEditorTrayWindows(windows, activeWorkspaceId),
    trayItems,
    pathMenu,
    pathMenuItems,
    openPathMenu,
    closePathMenu,
    createPrompt,
    confirmCreate,
    cancelCreate,
    openError,
    dismissOpenError,
    updateWindowRect,
    setWindowDirty,
    orphanWindow,
    closeWindow,
    minimizeWindow,
    toggleMaximizeWindow,
    writeFile: fileApi.writeFile,
    pendingStackRestore,
    clearPendingStackRestore,
  };
}
