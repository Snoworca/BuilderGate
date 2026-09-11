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
import {
  closeEditorTab,
  selectEditorTab,
} from '../components/editor/editorWindowTabs.ts';
import { raiseDialogById } from '../components/dialog/dialogStack.ts';
import {
  editorWindowDialogId,
  EDITOR_WINDOW_MIN_SIZE,
} from '../components/editor/EditorWindow.tsx';
import { computeInitialEditorWindowRect } from '../components/editor/editorWindowInitialRect.ts';
import { EDITOR_WINDOW_BOUNDS_SELECTOR } from '../components/editor/editorWindowBounds.ts';
import {
  readEditorWindowGeometry,
  writeEditorWindowGeometry,
} from '../components/editor/editorWindowGeometryCache.ts';
import {
  resolveEditorWindowPlacementMode,
} from '../components/editor/editorWindowPlacementMode.ts';
import {
  minimizeEditorWindow,
  type EditorWindowScreen,
} from '../components/editor/editorWindowVisibility.ts';
import {
  countEditorTrayWindows,
  hasEditorTrayWindows,
  listEditorTrayEntries,
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
 * One open document: a tab of its workspace's editor window.
 *
 * The placement fields that used to sit here have moved up to the window, which
 * there is now one of per workspace. What stays is what differs between
 * documents -- where it came from, where it saves to, and whether it is
 * unsaved.
 * @req FR-MDE-007
 * @req FR-MDE-008
 */
export type EditorDocumentState = EditorTrayWindow & {
  /** The content read from disk when the document opened. Never fed back. */
  bodyAtOpen: string;
};

/**
 * A workspace's editor window, which exists exactly while that workspace has
 * an open document.
 *
 * Kept per workspace rather than globally: the visibility rule scopes a window
 * to its workspace, so one global window would show workspace A's tabs while
 * the user is in B. Only the geometry is shared, and that lives in the dialog
 * store rather than here.
 * @req FR-MDE-001
 */
export interface EditorWindowShell {
  /** The workspace this window belongs to, which is what scopes its visibility. */
  workspaceId: string;
  placement: EditorWindowPlacement;
  /** The placement recorded on entry to `stage`, or null when none was. */
  placementBeforeStage: EditorWindowPlacement | null;
  /** Where a `floating` window floats. Null until it has been dragged. */
  floatingRect: DialogRect | null;
  minimized: boolean;
  /** Which tab is on screen. Null only between the last close and the unmount. */
  activeFilePath: string | null;
}

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
  /**
   * Returned to when a document is chosen from the tray while the settings
   * screen is up. The screen itself is not read: a window is hidden by the
   * visibility rule, which the layer applies, rather than by this hook.
   */
  setScreen: (screen: EditorWindowScreen) => void;
  activeWorkspaceId: string | null;
  /**
   * Moves the app to another workspace.
   *
   * Needed because the document list spans every workspace: choosing a row for
   * a document that lives elsewhere is how the user asks to go there.
   * @req FR-MDE-008
   */
  setActiveWorkspaceId: (workspaceId: string) => void;
  /**
   * The workspaces, by id and display name. Only the name is read, and it is
   * read for the tray rows -- this hook holds no opinion about what else a
   * workspace is.
   */
  workspaces: readonly { id: string; name: string }[];
  /**
   * The mobile layout is being rendered. A window fills the stage there and
   * leaves the shared position cache alone, so a phone-sized rect is not
   * inherited by the next desktop window.
   * @req FR-MDE-001
   */
  isMobile: boolean;
  /**
   * Only the id, the displayed cwd and the name are read, so the workspace type
   * stays out. The name is what a tray row shows for the terminal a document
   * saves to.
   */
  tabs: readonly { id: string; cwd: string; name: string }[];
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
  /** Every open document, of every workspace, in the order they were opened. */
  documents: EditorDocumentState[];
  /**
   * One window per workspace that has an open document.
   *
   * Every workspace's, not only the active one's: the layer mounts them all and
   * hides the ones that are not on screen, because unmounting a window would
   * take the editors inside it and the bodies nobody has saved.
   */
  editorWindows: EditorWindowShell[];
  /** The documents of one window, in tab order. */
  tabsOf: (workspaceId: string) => EditorDocumentState[];
  selectDocument: (filePath: string) => void;
  closeDocument: (filePath: string) => void;
  /** Whether the tray icon renders. Scoped exactly as the list is. */
  hasWindows: boolean;
  /** How many documents are open, which the tray icon carries as a badge. */
  openCount: number;
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
  updateWindowRect: (rect: DialogRect) => void;
  /** A document started, or stopped, differing from the file. */
  setWindowDirty: (filePath: string, dirty: boolean) => void;
  /** Closes the whole window, which closes every document in it. */
  closeWindow: () => void;
  minimizeWindow: () => void;
  toggleMaximizeWindow: () => void;
  writeFile: (sessionId: string, path: string, content: string) => Promise<{ success: boolean }>;
}

/**
 * @req FR-MDE-007
 * @req FR-MDE-008
 */
export function useEditorWindows(input: UseEditorWindowsInput): UseEditorWindowsResult {
  const {
    setScreen,
    activeWorkspaceId,
    setActiveWorkspaceId,
    workspaces,
    isMobile,
    tabs,
    resolveTabSession,
    activeWorkspaceTabIds,
    windowState,
  } = input;
  const { restoreWindows, saveWindows } = windowState;

  // FR-MDE-007's path menu is one of the two things that creates a window; the
  // other is FR-MDE-009's restore, below.
  const [documents, setDocuments] = useState<EditorDocumentState[]>([]);
  // One shell per workspace, created with that workspace's first document and
  // dropped with its last. Keyed rather than singular because the visibility
  // rule scopes a window to its workspace.
  const [shells, setShells] = useState<Record<string, EditorWindowShell>>({});
  const [pathMenu, setPathMenu] = useState<EditorPathMenuAnchor | null>(null);
  const [createPrompt, setCreatePrompt] = useState<EditorCreatePrompt | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
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
  // The session lookup as it is right now. The restore reads it per file rather
  // than closing over it, for the reason this hook resolves sessions per call
  // everywhere else: a restart replaces the session and keeps the tab.
  const resolveTabSessionRef = useRef(resolveTabSession);
  // The committed document list, for the restore to compare against once its
  // reads have finished. The list it captured when the effect ran was the one
  // before any of them landed.
  const documentsRef = useRef(documents);
  // Assigned after the commit rather than during the render. A render body runs
  // for renders React then throws away, so a ref written there can hold a value
  // that was never committed -- and the restore reads these from an async
  // continuation, where "the latest render" and "what is on screen" differ.
  // Declared above the effects that read them so it runs first in each commit.
  useEffect(() => {
    resolveTabSessionRef.current = resolveTabSession;
    documentsRef.current = documents;
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

  /**
   * Applies one change to the active workspace's shell, creating nothing. A
   * workspace with no window has nothing for these controls to act on.
   * @req FR-MDE-001
   */
  const updateShell = useCallback((
    change: (shell: EditorWindowShell) => EditorWindowShell,
  ) => {
    const workspaceId = activeWorkspaceId;
    if (workspaceId === null) return;

    setShells((current) => {
      const shell = current[workspaceId];
      if (shell === undefined) return current;

      const next = change(shell);
      return next === shell ? current : { ...current, [workspaceId]: next };
    });
  }, [activeWorkspaceId]);

  /**
   * Brings a document to the screen: un-hides its window, returns to the
   * workspace screen if the settings screen is up, and selects its tab.
   *
   * The terminal tab is deliberately not touched. A window holds documents
   * opened from several terminals, so there is no one terminal to switch to,
   * and switching would move the user's terminal out from under them.
   * @req FR-MDE-007
   * @req FR-MDE-008
   */
  const reviveByPath = useCallback((filePath: string, targetWorkspaceId?: string) => {
    const workspaceId = targetWorkspaceId ?? activeWorkspaceId;
    if (workspaceId === null) return;

    setScreen('workspace');

    // The document may live in another workspace, and the list spans them all.
    // Moving there is the whole of what makes the row work; the window itself
    // is already mounted, so nothing is read from disk and no unsaved body is
    // rebuilt.
    if (workspaceId !== activeWorkspaceId) {
      setActiveWorkspaceId(workspaceId);
    }

    setShells((current) => {
      const shell = current[workspaceId];
      if (shell === undefined) return current;

      return {
        ...current,
        [workspaceId]: { ...shell, minimized: false, activeFilePath: filePath },
      };
    });
    raiseDialogById(editorWindowDialogId(workspaceId), 'modeless');
  }, [activeWorkspaceId, setActiveWorkspaceId, setScreen]);

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
    const workspaceId = activeWorkspaceId;
    if (workspaceId === null) return;

    // This path is open now, so the store no longer needs the restore to carry
    // its stored record: closing this document must remove it.
    // @req FR-MDE-009
    forgetPendingRestore(filePath);

    setDocuments((current) => {
      if (current.some(document => document.filePath === filePath)) {
        return current;
      }

      return [...current, {
        filePath,
        tabId,
        workspaceId,
        // A document opens on the body it just read, so it starts clean. The
        // panel reports every change to this through `setWindowDirty`.
        dirty: false,
        bodyAtOpen,
      }];
    });

    setShells((current) => {
      const shell = current[workspaceId];
      if (shell !== undefined) {
        // The window is already open; the document becomes its active tab.
        return { ...current, [workspaceId]: { ...shell, minimized: false, activeFilePath: filePath } };
      }

      // A window opens floating at seven tenths of the viewport rather than
      // filling the stage. Filling it would put the window over the terminal's
      // own path bar and over every window already open, which is exactly what
      // one window per document used to avoid by covering only its own
      // terminal.
      //
      // Two boxes are measured, not one. The size comes from the viewport; the
      // position is centred inside the stage, because the stage is what the
      // window layer confines a floating window to. Centring against the
      // viewport alone put the window against the stage's left edge, the
      // sidebar's width away from where it belonged.
      //
      // Measured here rather than inside the rule, so the rule stays decidable
      // without a browser. The guard is not defensive padding: suites run this
      // module with no DOM installed, where a bare `window` is a ReferenceError
      // rather than an absent value.
      const viewport = typeof window === 'undefined'
        ? { width: 0, height: 0 }
        : { width: window.innerWidth, height: window.innerHeight };
      const stage = typeof document === 'undefined'
        ? null
        : document.querySelector(EDITOR_WINDOW_BOUNDS_SELECTOR);
      const bounds = stage === null
        ? { left: 0, top: 0, ...viewport }
        : stage.getBoundingClientRect();
      const mode = resolveEditorWindowPlacementMode({ isMobile });

      // On mobile the window fills the stage, and the placement state is left
      // at its `stage` default with no rect of its own.
      if (!mode.usesGeometryCache) {
        return {
          ...current,
          [workspaceId]: {
            ...createEditorWindowPlacementState(),
            workspaceId,
            minimized: false,
            activeFilePath: filePath,
          },
        };
      }

      // Where the user last left a window wins over the opening placement. The
      // cache is global, so a window opened in any workspace comes up where the
      // last one was dragged to -- which is what "one cached position" means.
      const cached = typeof localStorage === 'undefined'
        ? null
        : readEditorWindowGeometry(viewport, EDITOR_WINDOW_MIN_SIZE, localStorage);
      const initialRect = cached ?? computeInitialEditorWindowRect(
        viewport,
        bounds,
        EDITOR_WINDOW_MIN_SIZE,
      );

      return {
        ...current,
        [workspaceId]: {
          ...enterFloating(createEditorWindowPlacementState(), initialRect),
          workspaceId,
          minimized: false,
          activeFilePath: filePath,
        },
      };
    });

    // Reopening a file that is already open selects its tab instead of adding
    // a second one, which is what the guard above leaves to be done. A window
    // being created for the first time has not registered yet, so this finds
    // nothing and says so -- which is right: it is the only window there is.
    // @req FR-MDE-007
    raiseDialogById(editorWindowDialogId(workspaceId), 'modeless');
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
      openWindows: documents,
      onSelect: handleSelect,
    });
  }, [documents, handleSelect, pathMenu, tabs]);

  // The names the rows read, attached here rather than looked up inside the
  // tray model: that model turns documents into rows and has no business
  // knowing what a workspace list is. A name that is gone comes through as
  // undefined, and the row says so rather than going blank.
  //
  // Keyed on the names rather than on the arrays holding them. `tabs` and
  // `workspaces` are rebuilt on every render, so depending on them rebuilds
  // this list every render, and every rebuild is a new `trayItems` -- which is
  // a new prop for the header, which re-renders it. A component that re-renders
  // on every commit keeps replacing its own DOM nodes, and anything measuring
  // that DOM sees a list that never settles. The same reason the restore effect
  // below keys on a joined id list.
  const trayNameKey = [
    workspaces.map(workspace => `${workspace.id}\u0000${workspace.name}`).join('\u0001'),
    tabs.map(tab => `${tab.id}\u0000${tab.name}`).join('\u0001'),
  ].join('\u0002');

  const trayItems = useMemo<ContextMenuItem[]>(
    () => {
      const named: EditorTrayWindow[] = documents.map(document => ({
        ...document,
        workspaceName: workspaces.find(workspace => workspace.id === document.workspaceId)?.name,
        tabName: tabs.find(tab => tab.id === document.tabId)?.name,
      }));

      return listEditorTrayEntries(named).map(entry => ({
        label: entry.label,
        // The rows carry absolute paths, which are long. The class is what lets
        // the menu set a smaller type for them without shrinking every other
        // context menu in the application.
        className: 'editor-tray-item',
        onClick: () => reviveByPath(entry.filePath, entry.workspaceId),
      }));
    },
    // `tabs` and `workspaces` are read inside but are deliberately not depended
    // on: their identities change every render while their names do not, and
    // `trayNameKey` carries exactly the part that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [documents, reviveByPath, trayNameKey],
  );

  /**
   * Applies one change to the document holding `filePath` and leaves the rest
   * alone, so the identity rule -- the resolved absolute path -- is stated
   * once.
   * @req FR-MDE-001
   */
  const updateDocument = useCallback((
    filePath: string,
    change: (document: EditorDocumentState) => EditorDocumentState,
  ) => {
    setDocuments((current) => {
      const next = current.map(document => (
        document.filePath === filePath ? change(document) : document
      ));

      // The same list when nothing moved, so a change that decides to keep the
      // record it was given does not cost a render.
      return next.every((document, index) => document === current[index])
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
  const updateWindowRect = useCallback((rect: DialogRect) => {
    // `WindowDialog` emits this from its drag and resize handlers only, so an
    // arrival here means the user placed the window by hand. That is both what
    // turns the placement `floating` and what the cache is meant to remember --
    // a rect the application computed would teach it nothing.
    if (resolveEditorWindowPlacementMode({ isMobile }).usesGeometryCache
      && typeof localStorage !== 'undefined') {
      writeEditorWindowGeometry(rect, localStorage);
    }
    updateShell(shell => ({ ...shell, ...enterFloating(shell, rect) }));
  }, [isMobile, updateShell]);

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
    updateDocument(filePath, document => (
      document.dirty === dirty ? document : { ...document, dirty }
    ));
  }, [updateDocument]);

  /**
   * Closes one document. The window goes with its last tab: an empty window
   * shows nothing and carries no title.
   * @req FR-MDE-012
   */
  const closeDocument = useCallback((filePath: string) => {
    const workspaceId = activeWorkspaceId;

    setDocuments(current => current.filter(document => document.filePath !== filePath));

    if (workspaceId === null) return;
    setShells((current) => {
      const shell = current[workspaceId];
      if (shell === undefined) return current;

      const own = documentsRef.current.filter(document => document.workspaceId === workspaceId);
      const closed = closeEditorTab(
        { tabs: own, activeFilePath: shell.activeFilePath },
        filePath,
      );

      if (closed.tabs.length === 0) {
        const { [workspaceId]: _removed, ...rest } = current;
        return rest;
      }

      return { ...current, [workspaceId]: { ...shell, activeFilePath: closed.activeFilePath } };
    });
  }, [activeWorkspaceId]);

  /** Selects an already-open document's tab. */
  const selectDocument = useCallback((filePath: string) => {
    const workspaceId = activeWorkspaceId;
    if (workspaceId === null) return;

    setShells((current) => {
      const shell = current[workspaceId];
      if (shell === undefined) return current;

      const own = documentsRef.current.filter(document => document.workspaceId === workspaceId);
      const selected = selectEditorTab({ tabs: own, activeFilePath: shell.activeFilePath }, filePath);
      if (selected.activeFilePath === shell.activeFilePath) return current;

      return { ...current, [workspaceId]: { ...shell, activeFilePath: selected.activeFilePath } };
    });
  }, [activeWorkspaceId]);

  /**
   * Closes the window and every document in it. The title bar's close control
   * asks each panel first, so by the time this runs nothing is unsaved.
   * @req FR-MDE-012
   */
  const closeWindow = useCallback(() => {
    const workspaceId = activeWorkspaceId;
    if (workspaceId === null) return;

    setDocuments(current => current.filter(document => document.workspaceId !== workspaceId));
    setShells((current) => {
      if (current[workspaceId] === undefined) return current;
      const { [workspaceId]: _removed, ...rest } = current;
      return rest;
    });
  }, [activeWorkspaceId]);

  const minimizeWindow = useCallback(() => {
    updateShell(shell => ({ ...shell, ...minimizeEditorWindow(shell) }));
  }, [updateShell]);

  const toggleMaximizeWindow = useCallback(() => {
    updateShell(shell => ({ ...shell, ...toggleMaximize(shell) }));
  }, [updateShell]);

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
    if (records.length === 0) return;

    // Deliberately not cancelled when this effect re-runs. `activeWorkspaceTabIds`
    // is rebuilt on every render, so a cleanup that aborted the reads would abort
    // them on the very next render -- and the guard above would then refuse to
    // start again, leaving the workspace permanently unrestored. Finishing is
    // also the right answer on a workspace switch: these windows belong to the
    // workspace they were read for, and the list holds every workspace's at once.
    void (async () => {
      const restored: EditorDocumentState[] = [];
      for (const record of records) {
        // Resolved through the ref rather than the captured lookup: a tab
        // restart keeps the tab id and replaces the session, and a lookup
        // captured when this effect ran would keep handing out the dead one.
        const sessionId = resolveTabSessionRef.current(record.tabId);
        if (sessionId === undefined) continue;

        try {
          const file = await fileApi.readFile(sessionId, record.filePath);
          restored.push({
            filePath: record.filePath,
            tabId: record.tabId,
            workspaceId,
            dirty: false,
            bodyAtOpen: file.content,
          });
        } catch {
          // The file is gone or unreadable. The record stays pending, so the
          // store keeps it and a later page load can try again.
        }
      }

      // A document the user opened by hand while the reads were in flight
      // wins: it is the same file and it already holds the body they are
      // looking at.
      //
      // The comparison reads the committed list through a ref rather than from
      // inside the updater. React does not promise to run an updater at the
      // moment it is dispatched -- with another update already pending on this
      // component it is deferred to the render phase -- so a value computed in
      // there and read afterwards would still be empty.
      const alreadyOpen = new Set(documentsRef.current.map(document => document.filePath));
      const added = restored.filter(document => !alreadyOpen.has(document.filePath));

      if (added.length === 0) return;

      // The updater still checks for itself. `added` was decided against the
      // last committed list, and a document opened between that commit and
      // this dispatch would otherwise be added a second time under the path.
      setDocuments((current) => {
        const open = new Set(current.map(document => document.filePath));
        return [...current, ...added.filter(document => !open.has(document.filePath))];
      });
      added.forEach(document => forgetPendingRestore(document.filePath));

      // The restored documents need a window to be tabs of. The first of them
      // becomes the active tab, which is the same rule a hand-opened document
      // follows.
      setShells((current) => {
        if (current[workspaceId] !== undefined) return current;

        return {
          ...current,
          [workspaceId]: {
            ...createEditorWindowPlacementState(),
            workspaceId,
            minimized: false,
            activeFilePath: added[0].filePath,
          },
        };
      });
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

    const shell = shells[workspaceId];
    const own = documents.filter(document => document.workspaceId === workspaceId);
    const openPaths = new Set(own.map(document => document.filePath));
    const stillPending = (pendingRestoreRef.current.get(workspaceId) ?? [])
      .filter(record => !openPaths.has(record.filePath));

    saveWindows([
      ...own.map(document => toEditorWindowRecord({
        tabId: document.tabId,
        filePath: document.filePath,
        placement: shell?.placement ?? 'stage',
        placementBeforeStage: shell?.placementBeforeStage ?? null,
        minimized: shell?.minimized ?? false,
        floatingRect: shell?.floatingRect ?? null,
      })),
      ...stillPending,
    ]);
  }, [activeWorkspaceId, documents, saveWindows, shells]);

  // In a stable order, so a workspace whose window mounted earlier keeps its
  // position in the tree. React keys them by workspace, but an order that
  // shuffled would still reorder the DOM nodes for no reason.
  const editorWindows = useMemo(
    () => Object.keys(shells).sort().map(id => shells[id]),
    [shells],
  );

  const tabsOf = useCallback(
    (workspaceId: string) => documents.filter(document => document.workspaceId === workspaceId),
    [documents],
  );

  return {
    documents,
    editorWindows,
    tabsOf,
    selectDocument,
    closeDocument,
    hasWindows: hasEditorTrayWindows(documents),
    openCount: countEditorTrayWindows(documents),
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
    closeWindow,
    minimizeWindow,
    toggleMaximizeWindow,
    writeFile: fileApi.writeFile,
  };
}
