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
// @req FR-MDE-012

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { IconButton, IconToggleButton } from '../common';
import { WindowDialog } from '../dialog/WindowDialog';
import type { DialogRect, DialogSize } from '../dialog/types';
// The window's own light surface. Imported here because the rules it sets are
// scoped to `.editor-window-surface`, which is this component's class.
import './EditorWindow.css';
import { EditorDocumentPanel, type EditorDocumentHandle } from './EditorDocumentPanel.tsx';
import { EditorTabBar } from './EditorTabBar.tsx';
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

const BODY_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  height: '100%',
};

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
  /** The title bar's close control was used, which closes the whole window. */
  onCloseWindow: () => void;
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
  hidden,
  resolveTabSession,
  writeFile,
  maximized,
  onToggleMaximize,
  onMinimize,
  onDirtyChange,
  onCloseWindow,
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
   * The title bar's close control closes the window, which means closing every
   * tab in it.
   *
   * Asked one at a time, oldest first, and each panel decides for itself
   * whether to prompt. A panel that prompts stops the sweep where it is: the
   * user is answering about that document, and closing the ones behind it
   * while the question is on screen would take documents they have not been
   * asked about. The remaining tabs are closed by the next press.
   * @req FR-MDE-012
   */
  const requestCloseWindow = useCallback(() => {
    const dirtyTab = tabs.find(tab => handlesRef.current.get(tab.filePath)?.isDirty() === true);
    if (dirtyTab !== undefined) {
      onSelectTab(dirtyTab.filePath);
      handlesRef.current.get(dirtyTab.filePath)?.requestClose();
      return;
    }

    onCloseWindow();
  }, [onCloseWindow, onSelectTab, tabs]);

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
      onClose={requestCloseWindow}
      showCloseButton
      resizable
      persistGeometry={false}
      surfaceClassName="editor-window-surface"
      rect={rect}
      onRectChange={onRectChange}
      boundsElement={boundsElement}
      titlebarActions={titlebarActions}
      dirty={activeTab?.dirty === true}
    >
      <div style={BODY_STYLE}>
        <EditorTabBar
          tabs={tabs}
          activeFilePath={activeFilePath}
          onSelect={onSelectTab}
          onClose={onCloseTab}
        />
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
    </WindowDialog>
  );
}
