// The one editor window of a workspace: a WindowDialog holding a row of tabs
// and the document panels behind them.
//
// The window owns the frame, the title bar and which tab is active. It owns no
// document: each panel holds its own editor instance, its own save controller
// and the body the user has typed, and the title bar reaches the active one
// through a handle that panel registers. A window that held copies of those
// would have to answer for whichever copy was written last.
//
// Every open document stays mounted, including the ones behind inactive tabs.
// The editor reads `markdownSource` once at mount and owns the document from
// then on, so unmounting a panel to hide it throws away whatever is unsaved in
// it. Hiding is `display: none` and nothing else.
//
// @req FR-MDE-001
// @req FR-MDE-002
// @req FR-MDE-006
// @req FR-MDE-010
// @req FR-MDE-011
// @req FR-MDE-012

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type TouchEvent as ReactTouchEvent,
} from 'react';
import { IconButton, IconToggleButton } from '../common';
import { ContextMenu } from '../ContextMenu/ContextMenu';
import { WindowDialog } from '../dialog/WindowDialog';
import { readEditorTreePaneState, saveEditorTreePaneState } from '../../hooks/windowStateStorage.ts';
import { useResponsive } from '../../hooks/useResponsive.ts';
import { useLongPress } from '../../hooks/useLongPress.ts';
import type { DialogRect, DialogSize } from '../dialog/types';
// The window's own light surface. Imported here because the rules it sets are
// scoped to `.editor-window-surface`, which is this component's class.
import './EditorWindow.css';
import { EditorDocumentPanel, type EditorDocumentHandle } from './EditorDocumentPanel.tsx';
import { EditorFileTreePane } from './EditorFileTreePane.tsx';
import {
  applyPaneDrag,
  buildEditorWindowContextMenu,
  clampPaneDragWidth,
  collapseAfterOpen,
  isEditorWindowMenuTarget,
  paneInitiallyCollapsed,
  renderPaneWidth,
  resetPaneWidth,
  type EditorWindowMenuTarget,
} from './editorFileTreePaneModel.ts';
import { EditorTabBar } from './EditorTabBar.tsx';
import { planEditorWindowCloseControl } from './editorWindowCloseControl.ts';
import { createEditorWindowSaveShortcutHandler } from './editorWindowSaveShortcut.ts';

/**
 * The smallest an editor window asks to be drawn at.
 *
 * Module level so the reference is stable: WindowDialog puts minSize into
 * callback dependencies, and a fresh object per render would rebuild them all.
 *
 * Exported because `EditorWindowLayer` needs the same numbers for the floor the
 * placement is not shrunk below, and two copies of a floor drift apart.
 * @req FR-MDE-001
 */
export const EDITOR_WINDOW_MIN_SIZE: DialogSize = { width: 320, height: 240 };

// WindowDialog reads this into its uncontrolled rect on every mount, whatever
// `persistGeometry` says, and the controlled `rect` below then supersedes it.
const SUPERSEDED_DEFAULT_RECT: DialogRect = { x: 0, y: 0, width: 720, height: 520 };

const ACTIONS_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
};

const BADGE_STYLE: CSSProperties = {
  padding: '1px 6px',
  borderRadius: '3px',
  background: '#4a3a12',
  color: '#f0d9a0',
  fontSize: '11px',
  whiteSpace: 'nowrap',
};

/**
 * The dialog id the editor window of  registers under.
 *
 * Keyed by workspace rather than by document: one window holds every document
 * of a workspace, so an id that moved with the active tab would re-register the
 * same window under a new id on every tab switch. Keyed at all rather than
 * constant because every workspace's window is mounted at once -- only one is
 * on screen, but they all live in the modeless stack, and two sharing an id
 * would make a raise ambiguous.
 *
 * Exported because raising the window from outside it -- opening a file, or
 * choosing one from the tray -- names it by this id, and an id spelled out at
 * both ends would drift.
 * @req FR-MDE-003
 * @req FR-MDE-009
 */
export function editorWindowDialogId(workspaceId: string): string {
  return `editor-window:${workspaceId}`;
}

/** One open document, as the window needs to know it. */
export interface EditorWindowTab {
  /** The normalized absolute file path. Identity of the tab. */
  filePath: string;
  /** The terminal tab this document saves to. */
  tabId: string;
  /** The content read from disk when the document opened. */
  bodyAtOpen: string;
  /** The document differs from the file, as the panel last reported it. */
  dirty: boolean;
}

export interface EditorWindowProps {
  /** In the order they were opened, which is the order the row draws them. */
  tabs: readonly EditorWindowTab[];
  /** Which tab is on screen. Null only while the window is closing. */
  activeFilePath: string | null;
  onSelectTab: (filePath: string) => void;
  /** The tab's close control was used. The panel may prompt before it goes. */
  onCloseTab: (filePath: string) => void;
  rect: DialogRect;
  onRectChange: (rect: DialogRect) => void;
  /** Drag boundary. The stage, whatever the placement. */
  boundsElement?: string | Element;
  /**
   * The window can be moved and resized by hand.
   *
   * False on a mobile layout, where the window fills the stage: there is
   * nowhere to move it to, and a drag would emit a rect the host would cache --
   * a cache shared with the desktop layout, which would then open its windows
   * at a phone's size.
   * @req FR-MDE-001
   */
  placeable: boolean;
  /** The workspace this window belongs to. Its dialog id is derived from it. */
  workspaceId: string;
  /** The visibility predicate said no. The surface hides; nothing unmounts. */
  hidden: boolean;
  resolveTabSession: (tabId: string) => string | undefined;
  writeFile: (sessionId: string, path: string, content: string) => Promise<{ success: boolean }>;
  /**
   * The window is filling the stage right now.
   *
   * Passed in rather than held here: the placement is the layer's to own, and a
   * second copy in this component would answer for whichever of the two was
   * written last.
   */
  maximized: boolean;
  onToggleMaximize: () => void;
  onMinimize: () => void;
  /**
   * A document started, or stopped, differing from the file it was read from.
   * @req FR-MDE-008
   */
  onDirtyChange: (filePath: string, dirty: boolean) => void;
  /**
   * The working directory of a terminal tab's session, which is where the
   * left file-tree pane starts. Undefined while the tab has none to report.
   * @req FR-MDE-012
   */
  resolveTabCwd: (tabId: string) => string | undefined;
  /**
   * A file chosen in the left file-tree pane opens as a tab of this window,
   * bound to the active tab's terminal tab -- the route the explorer's files
   * take.
   * @req FR-MDE-012
   */
  onOpenFile: (filePath: string, tabId: string) => void;
}

/** A drag of the pane's splitter, from pointerdown to its end. */
interface PaneDrag {
  pointerId: number;
  startX: number;
  startWidth: number;
  /** The width the drag last produced: what is saved when it ends. */
  width: number;
  /** A press that never moved saves nothing, or it would save a clipped width. */
  moved: boolean;
}

function fileNameOf(filePath: string): string {
  const segments = filePath.split(/[\\/]/);
  return segments[segments.length - 1] || filePath;
}

/**
 * @req FR-MDE-001
 * @req FR-MDE-006
 */
export function EditorWindow({
  workspaceId,
  tabs,
  activeFilePath,
  onSelectTab,
  onCloseTab,
  rect,
  onRectChange,
  boundsElement,
  placeable,
  hidden,
  resolveTabSession,
  writeFile,
  maximized,
  onToggleMaximize,
  onMinimize,
  onDirtyChange,
  resolveTabCwd,
  onOpenFile,
}: EditorWindowProps) {
  const actionsRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLElement | null>(null);
  const shownFrameDisplayRef = useRef<string | null>(null);
  const shownSurfaceDisplayRef = useRef<string | null>(null);

  // What each mounted panel handed over. A plain ref rather than state: the
  // window reads it inside callbacks, never during a render, so a registration
  // arriving between renders does not need one of its own.
  const handlesRef = useRef(new Map<string, EditorDocumentHandle>());

  const registerHandle = useCallback((filePath: string, handle: EditorDocumentHandle | null) => {
    if (handle === null) {
      handlesRef.current.delete(filePath);
      return;
    }
    handlesRef.current.set(filePath, handle);
  }, []);

  const activeTab = tabs.find(tab => tab.filePath === activeFilePath) ?? null;
  const activeTabClosed = activeTab !== null && resolveTabSession(activeTab.tabId) === undefined;

  // The left file-tree pane follows the active tab's session (FR-MDE-012 AC-5).
  // Without a live session or a directory to start from there is nothing to
  // list, so the pane is not mounted at all.
  const paneSessionId = activeTab === null ? undefined : resolveTabSession(activeTab.tabId);
  const paneCwd = activeTab === null ? undefined : resolveTabCwd(activeTab.tabId);
  const paneMounted = paneSessionId !== undefined && paneCwd !== undefined && paneCwd !== '';

  const { isMobile } = useResponsive();
  // Width and fold are the workspace's (AC-12). The saved width is what the
  // user chose; what is drawn is that width clipped to this window (AC-11), and
  // the clip never flows back into what is saved.
  const [savedPane] = useState(() => readEditorTreePaneState(workspaceId));
  const [paneWidth, setPaneWidth] = useState(savedPane.width);
  const [paneCollapsed, setPaneCollapsed] = useState(() => paneInitiallyCollapsed({ isMobile, savedCollapsed: savedPane.collapsed }));
  // A pane that was never opened is never mounted, so a window that does not
  // use it lists no directory. Once opened it stays mounted while folded, so
  // expanded folders and the selection survive a close and reopen.
  const [paneEverOpened, setPaneEverOpened] = useState(!paneCollapsed);
  const paneRenderWidth = renderPaneWidth(paneWidth, rect.width);
  const paneDragRef = useRef<PaneDrag | null>(null);

  // A phone's fold is not remembered: the pane always starts folded there, and
  // opening it for one file must not open it on the desktop next time.
  const setPaneOpen = useCallback((open: boolean) => {
    // With no session to list there is no pane to open; flipping the state
    // would only show a check mark over nothing and save it.
    if (open && !paneMounted) return;
    setPaneCollapsed(!open);
    if (open) setPaneEverOpened(true);
    if (!isMobile) saveEditorTreePaneState(workspaceId, { width: paneWidth, collapsed: !open });
  }, [isMobile, paneMounted, paneWidth, workspaceId]);

  // A window narrowed to phone width would leave the pane covering the
  // document; it folds, and that fold is not saved.
  useEffect(() => {
    if (isMobile) setPaneCollapsed(true);
  }, [isMobile]);

  const startPaneDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    // The drag starts from the width on screen, so the band does not jump when
    // the saved width is wider than this window allows.
    paneDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: paneRenderWidth, width: paneWidth, moved: false };
  };

  const movePaneDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = paneDragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    drag.width = applyPaneDrag(drag.startWidth, event.clientX - drag.startX, rect.width);
    drag.moved = true;
    setPaneWidth(drag.width);
  };

  // Saved once, when the drag ends: a pointermove fires many times a second.
  const endPaneDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = paneDragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    paneDragRef.current = null;
    if (drag.moved) saveEditorTreePaneState(workspaceId, { width: drag.width, collapsed: paneCollapsed });
  };

  // Clamped to this window, so a reset in a narrow window does not save a
  // width past its cap.
  const resetPaneDrag = () => {
    const width = clampPaneDragWidth(resetPaneWidth(), rect.width);
    setPaneWidth(width);
    saveEditorTreePaneState(workspaceId, { width, collapsed: paneCollapsed });
  };

  // The close button is inside the pane, and folding hides it with focus on
  // it, which drops focus to body and leaves the editor's shortcuts dead.
  // Focus moves to the window surface first, which is what those shortcuts
  // measure against.
  const closePane = useCallback(() => {
    surfaceRef.current?.focus({ preventScroll: true });
    setPaneOpen(false);
  }, [setPaneOpen]);

  // On a phone the pane covers the document, so it folds once a file is open.
  const handlePaneOpenFile = useCallback((filePath: string) => {
    if (activeTab === null) return;
    onOpenFile(filePath, activeTab.tabId);
    if (collapseAfterOpen(isMobile)) setPaneCollapsed(true);
  }, [activeTab, isMobile, onOpenFile]);

  // The window menu opens only on the empty parts of the tab bar and the title
  // bar (AC-2). The document keeps the browser's own menu, which is in real use
  // in an editor.
  const [windowMenu, setWindowMenu] = useState<{ x: number; y: number } | null>(null);
  const windowMenuItems = buildEditorWindowContextMenu({
    paneOpen: paneMounted && !paneCollapsed,
    onTogglePane: () => setPaneOpen(paneCollapsed),
  });

  const handleTabBarContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const target: EditorWindowMenuTarget = event.target instanceof Element && event.target.closest('.editor-tab') !== null
      ? 'tab'
      : 'tabbar-empty';
    if (!isEditorWindowMenuTarget(target)) return;
    event.preventDefault();
    setWindowMenu({ x: event.clientX, y: event.clientY });
  };

  // iOS Safari raises no contextmenu for a long press, so on a phone the same
  // menu is reached by holding the same empty areas. Touch only: a held mouse
  // button on the title bar is the start of a drag.
  const openWindowMenuAt = useCallback((point: { clientX: number; clientY: number }) => {
    setWindowMenu({ x: point.clientX, y: point.clientY });
  }, []);
  const {
    onTouchStart: startWindowMenuLongPress,
    onTouchMove: moveWindowMenuLongPress,
    onTouchEnd: endWindowMenuLongPress,
  } = useLongPress(openWindowMenuAt);

  const handleTabBarTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    const target: EditorWindowMenuTarget = event.target instanceof Element && event.target.closest('.editor-tab') !== null
      ? 'tab'
      : 'tabbar-empty';
    if (!isEditorWindowMenuTarget(target)) return;
    startWindowMenuLongPress(event);
  };

  // WindowDialog portals into document.body and forwards no ref, so both nodes
  // are reached from one this component owns. They are different nodes and are
  // used for different things: the surface is what focus is measured against,
  // and the frame -- react-rnd's positioned root -- is what hiding and raising
  // act on. Hiding the surface alone would leave that root behind at full rect
  // with `pointer-events: auto` and its resize handles live, so an invisible
  // window would still swallow clicks meant for the terminal underneath.
  //
  // The frame goes into state rather than only a ref so the effects below re-run
  // when it resolves, instead of resting on layout effects running first.
  const [frame, setFrame] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const surface = actionsRef.current?.closest<HTMLElement>('.window-dialog-surface') ?? null;
    surfaceRef.current = surface;

    const nextFrame = surface?.closest<HTMLElement>('.window-dialog') ?? null;
    setFrame((previous) => (previous === nextFrame ? previous : nextFrame));
  });

  // Both nodes are hidden, and each for its own reason.
  //
  // The surface is what the criterion names, and it is what an assertion can
  // read: `display` is not inherited, so a surface inside a hidden frame still
  // computes the `flex` its stylesheet gives it.
  //
  // The frame -- react-rnd's positioned root -- has to go too. Hiding the
  // surface alone would leave that root at its full rect with
  // `pointer-events: auto` and its resize handles live, so an invisible window
  // would still swallow clicks meant for the terminal underneath it.
  //
  // Each remembers the value it had rather than being restored to an empty
  // string: react-rnd writes the frame's, and the surface's comes from a
  // stylesheet.
  // @req FR-MDE-002
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (frame === null || surface === null) return;

    if (shownFrameDisplayRef.current === null) {
      shownFrameDisplayRef.current = frame.style.display;
    }
    if (shownSurfaceDisplayRef.current === null) {
      shownSurfaceDisplayRef.current = surface.style.display;
    }

    frame.style.display = hidden ? 'none' : shownFrameDisplayRef.current;
    surface.style.display = hidden ? 'none' : shownSurfaceDisplayRef.current;
  }, [frame, hidden]);

  // WindowDialog draws the title bar and takes no menu for it, so its right
  // click is reached with a native listener on the node it renders.
  // @req FR-MDE-012
  useEffect(() => {
    const titlebar = frame?.querySelector<HTMLElement>('.window-dialog-titlebar') ?? null;
    if (titlebar === null) return undefined;
    const handleTitlebarContextMenu = (event: globalThis.MouseEvent) => {
      const target: EditorWindowMenuTarget = event.target instanceof Element && event.target.closest('button') !== null
        ? 'titlebar-button'
        : 'titlebar-empty';
      if (!isEditorWindowMenuTarget(target)) return;
      event.preventDefault();
      setWindowMenu({ x: event.clientX, y: event.clientY });
    };
    // The title bar is a node WindowDialog renders, so its long press takes
    // native listeners too. useLongPress only reads `touches`, which the native
    // event carries with the same shape.
    const handleTitlebarTouchStart = (event: globalThis.TouchEvent) => {
      const target: EditorWindowMenuTarget = event.target instanceof Element && event.target.closest('button') !== null
        ? 'titlebar-button'
        : 'titlebar-empty';
      if (!isEditorWindowMenuTarget(target)) return;
      startWindowMenuLongPress(event as unknown as ReactTouchEvent);
    };
    const handleTitlebarTouchMove = (event: globalThis.TouchEvent) => moveWindowMenuLongPress(event as unknown as ReactTouchEvent);
    titlebar.addEventListener('contextmenu', handleTitlebarContextMenu);
    titlebar.addEventListener('touchstart', handleTitlebarTouchStart);
    titlebar.addEventListener('touchmove', handleTitlebarTouchMove);
    titlebar.addEventListener('touchend', endWindowMenuLongPress);
    titlebar.addEventListener('touchcancel', endWindowMenuLongPress);
    return () => {
      titlebar.removeEventListener('contextmenu', handleTitlebarContextMenu);
      titlebar.removeEventListener('touchstart', handleTitlebarTouchStart);
      titlebar.removeEventListener('touchmove', handleTitlebarTouchMove);
      titlebar.removeEventListener('touchend', endWindowMenuLongPress);
      titlebar.removeEventListener('touchcancel', endWindowMenuLongPress);
    };
  }, [endWindowMenuLongPress, frame, moveWindowMenuLongPress, startWindowMenuLongPress]);

  const saveActive = useCallback(() => {
    if (activeFilePath === null) return;
    handlesRef.current.get(activeFilePath)?.save();
  }, [activeFilePath]);

  // Focus decides which window writes, and the active tab decides which
  // document it writes. There is one window per workspace, so the first half no
  // longer separates windows from each other -- what it still separates is the
  // editor from the rest of the page, which is what the criterion asks for.
  //
  // The whole surface counts, not just the editor: the title bar, the drag
  // handle and the close button are inside the window the user is looking at,
  // and pressing the close button then cancelling must not leave the shortcut
  // dead.
  // @req FR-MDE-006
  useEffect(() => {
    if (activeTab === null) return undefined;
    const { filePath, tabId } = activeTab;

    const handle = createEditorWindowSaveShortcutHandler({
      listWindows: () => {
        // A document whose terminal tab has closed has no save path at all, so
        // its press is not taken from the browser either.
        if (resolveTabSession(tabId) === undefined) {
          return [];
        }

        const active = document.activeElement;
        if (!(active instanceof Node)) {
          return [];
        }

        const surface = surfaceRef.current;
        const focused = surface !== null && surface.contains(active);

        return [{ documentId: filePath, focused }];
      },
      save: () => saveActive(),
    });

    const onKeyDown = (event: KeyboardEvent) => handle(event);
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [activeTab, resolveTabSession, saveActive]);

  /**
   * The title bar's close control closes the active document -- one per press.
   *
   * It goes through that document's own panel, which is the same path the
   * tab's own `x` takes, so the close branches of FR-MDE-006 decide whether
   * anything is asked. Closing the tab behind the panel's back would discard
   * an unsaved body with no prompt.
   *
   * The window is not closed here, and there is no longer anything that
   * closes it: it disappears when its last document does, which is already
   * what closing the last tab produces.
   * @req FR-MDE-011
   */
  const requestCloseActiveTab = useCallback(() => {
    const plan = planEditorWindowCloseControl({ tabs, activeFilePath });
    if (plan.kind === 'nothing') return;

    const handle = handlesRef.current.get(plan.filePath);
    // A tab whose panel has not registered yet has no unsaved body to lose,
    // so closing it directly is the same answer the panel would have given.
    if (handle === undefined) {
      onCloseTab(plan.filePath);
      return;
    }

    handle.requestClose();
  }, [activeFilePath, onCloseTab, tabs]);

  const titlebarActions = (
    <div ref={actionsRef} style={ACTIONS_STYLE} className="editor-window-actions">
      {activeTabClosed && (
        <span style={BADGE_STYLE} title="결속된 탭이 닫혀 저장할 수 없습니다">
          저장 불가
        </span>
      )}
      <IconButton
        icon="save"
        label="저장"
        disabled={activeTabClosed || activeTab === null}
        onClick={saveActive}
      />
      {/* One control for an axis with two ends, so the drawing says which end
          the window is at. Two separate buttons would have left that to the
          user to work out from the window itself. */}
      <IconToggleButton
        pressed={maximized}
        icons={{ on: 'restore', off: 'maximize' }}
        label="최대화"
        onToggle={onToggleMaximize}
      />
      <IconButton
        icon="minimize"
        label="최소화"
        onClick={onMinimize}
      />
    </div>
  );

  return (
    <WindowDialog
      dialogId={editorWindowDialogId(workspaceId)}
      title={activeTab === null ? '편집기' : fileNameOf(activeTab.filePath)}
      mode="modeless"
      defaultRect={SUPERSEDED_DEFAULT_RECT}
      minSize={EDITOR_WINDOW_MIN_SIZE}
      onClose={requestCloseActiveTab}
      showCloseButton
      resizable={placeable}
      movable={placeable}
      persistGeometry={false}
      surfaceClassName="editor-window-surface"
      rect={rect}
      onRectChange={onRectChange}
      boundsElement={boundsElement}
      titlebarActions={titlebarActions}
      dirty={activeTab?.dirty === true}
    >
      {/* The pane sits left of the tab bar rather than under it: the tabs
          belong to the documents, the tree to the whole window (design 9.1). */}
      <div className="editor-window-row">
        {paneMounted && paneEverOpened && activeTab !== null && (
          <EditorFileTreePane
            workspaceId={workspaceId}
            tabId={activeTab.tabId}
            sessionId={paneSessionId}
            sessionCwd={paneCwd}
            hidden={paneCollapsed}
            isMobile={isMobile}
            style={{ width: paneRenderWidth }}
            onClose={closePane}
            onOpenFile={handlePaneOpenFile}
          />
        )}
        {paneMounted && !paneCollapsed && !isMobile && (
          <div
            className="editor-tree-splitter"
            data-surface="paper"
            role="separator"
            aria-orientation="vertical"
            aria-label="파일 트리 폭"
            onPointerDown={startPaneDrag}
            onPointerMove={movePaneDrag}
            onPointerUp={endPaneDrag}
            onPointerCancel={endPaneDrag}
            onLostPointerCapture={endPaneDrag}
            onDoubleClick={resetPaneDrag}
          />
        )}
        <div className="editor-window-documents">
          <div
            className="editor-tab-bar-host"
            onContextMenu={handleTabBarContextMenu}
            onTouchStart={handleTabBarTouchStart}
            onTouchMove={moveWindowMenuLongPress}
            onTouchEnd={endWindowMenuLongPress}
            onTouchCancel={endWindowMenuLongPress}
          >
            <EditorTabBar
              tabs={tabs}
              activeFilePath={activeFilePath}
              onSelect={onSelectTab}
              onClose={onCloseTab}
            />
          </div>
          {tabs.map(tab => (
            <EditorDocumentPanel
              key={tab.filePath}
              filePath={tab.filePath}
              tabId={tab.tabId}
              bodyAtOpen={tab.bodyAtOpen}
              hidden={tab.filePath !== activeFilePath}
              resolveTabSession={resolveTabSession}
              writeFile={writeFile}
              onDirtyChange={(dirty) => onDirtyChange(tab.filePath, dirty)}
              onClose={() => onCloseTab(tab.filePath)}
              onRegisterHandle={registerHandle}
            />
          ))}
        </div>
        {windowMenu !== null && (
          <ContextMenu position={windowMenu} items={windowMenuItems} onClose={() => setWindowMenu(null)} />
        )}
      </div>
    </WindowDialog>
  );
}
