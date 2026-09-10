// One modeless editor window: a WindowDialog with the ported editor inside it.
//
// Two mount-time contracts of the editor decide most of what happens here.
// `markdownSource` is read once and the editor owns the document from then on,
// so the body is never fed back on a keystroke or after a save. `documentId` is
// the normalized absolute file path rather than the session id, because a tab
// restart replaces the session while keeping the file -- an id derived from the
// session would destroy and recreate the EditorView and take the unsaved body
// with it. `extensions` is captured at mount too, so its reference is pinned.
//
// @req FR-MDE-005
// @req FR-MDE-006
// @req CON-MDE-002

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { AtomicCodeMirrorEditor, doculightExtensions } from '../../editor';
import type { AtomicCodeMirrorEditorHandle } from '../../editor';
import { IconButton, IconToggleButton } from '../common';
import { WindowDialog } from '../dialog/WindowDialog';
import type { DialogRect, DialogSize } from '../dialog/types';
import { ConfirmModal } from '../Modal/ConfirmModal';
import '../Modal/ConfirmModal.css';
// The three-choice prompt below is drawn here rather than by ConfirmModal, and
// its rules are split across the two sheets: the overlay, panel, title and the
// two plain buttons come from RenameModal.css, while the message and the
// destructive button come from ConfirmModal.css above. Both are imported here so
// the prompt's appearance does not rest on some other component still importing
// one of them somewhere else in the graph.
import '../Modal/RenameModal.css';
// The window's own light surface. Imported here because the rules it sets are
// scoped to `.editor-window-surface`, which is this component's class.
import './EditorWindow.css';
import {
  createEditorWindowSaveController,
  type EditorWindowSaveController,
} from './editorWindowSave.ts';
import {
  decideEditorWindowClosePrompt,
  resolveEditorWindowCloseChoice,
  resolveEditorWindowSaveOnClose,
  type EditorWindowCloseChoice,
  type EditorWindowClosePrompt,
} from './editorWindowClose.ts';
import { createEditorWindowSaveShortcutHandler } from './editorWindowSaveShortcut.ts';

/**
 * The smallest an editor window asks to be drawn at.
 *
 * Module level so the reference is stable: WindowDialog puts minSize into
 * callback dependencies, and a fresh object per render would rebuild them all.
 *
 * Exported because `EditorWindowLayer` needs the same numbers for the floor the
 * cascade will not shrink a window below, and two copies of a floor drift apart
 * silently -- the layer would place a window at a size the window then refuses
 * to render at, and nothing would say which of the two was wrong.
 * @req FR-MDE-004
 */
export const EDITOR_WINDOW_MIN_SIZE: DialogSize = { width: 320, height: 240 };

// WindowDialog reads this into its uncontrolled rect on every mount, whatever
// `persistGeometry` says, and the controlled `rect` below then supersedes it.
// It therefore never reaches the screen, but it is read.
const SUPERSEDED_DEFAULT_RECT: DialogRect = { x: 0, y: 0, width: 720, height: 520 };

const BODY_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
};

// The document sits as a page inside the window rather than filling it: 95% of
// the body's height, with the remaining 5% falling to the auto margins as an
// even gap above and below.
//
// The height is expressed as a flex basis rather than as `height: 95%` because
// a percentage height would resolve against the body while the banner above it
// also takes room, and the two together would overflow. As a basis it shrinks
// when the banner appears, which is the behaviour the banner needs.
const EDITOR_HOST_STYLE: CSSProperties = {
  flex: '0 1 95%',
  minHeight: 0,
  marginBlock: 'auto',
  overflow: 'auto',
};

const BANNER_STYLE: CSSProperties = {
  flex: '0 0 auto',
  padding: '6px 10px',
  background: '#5a1d1d',
  color: '#ffd7d7',
  fontSize: '12px',
  wordBreak: 'break-word',
};

const ACTIONS_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  marginLeft: 'auto',
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
 * What a mounted window is handing the editor, kept so a caller outside React
 * can read it. `extensions` is held as the array object rather than its
 * contents, because what has to be observable is whether the reference changed.
 * @req FR-MDE-005
 */
interface EditorWindowProbe {
  documentId: string;
  markdownSource: string;
  extensions: object;
  setReadOnly: (readOnly: boolean) => boolean;
}

/**
 * Keyed by file path, which is what identifies a window here. Several windows
 * are open at once, so a single set of values would answer for whichever of
 * them mounted last rather than for the one being asked about.
 * @req FR-MDE-005
 */
const editorWindowProbes = new Map<string, EditorWindowProbe>();

/**
 * One number per `extensions` array object, so equal numbers mean the same
 * array. A WeakMap rather than a field written onto the array: the numbering
 * must not keep a closed window's extensions alive, and must not write to a
 * value the editor owns.
 * @req FR-MDE-005
 */
const extensionsTokens = new WeakMap<object, number>();
let nextExtensionsToken = 1;

// @req FR-MDE-005
function extensionsTokenOf(extensions: object): number {
  const existing = extensionsTokens.get(extensions);
  if (existing !== undefined) {
    return existing;
  }

  const token = nextExtensionsToken;
  nextExtensionsToken += 1;
  extensionsTokens.set(extensions, token);

  return token;
}

/**
 * What the window open on `filePath` is passing to the editor, or undefined
 * when no window is open on it. An absent window answers `undefined` rather
 * than empty values, so "no window" and "a window passing nothing" stay apart.
 *
 * Gated to localhost even though it only reads: `markdownSource` is the whole
 * file as it was read from disk, which is more than the retained-state reads
 * `terminalDebugCapture` already gates.
 * @req FR-MDE-005
 */
export function readEditorProbe(filePath: string): {
  documentId: string;
  markdownSource: string;
  extensionsToken: number;
} | undefined {
  if (!isLocalhostOrigin()) {
    return undefined;
  }

  const probe = editorWindowProbes.get(filePath);
  if (probe === undefined) {
    return undefined;
  }

  return {
    documentId: probe.documentId,
    markdownSource: probe.markdownSource,
    extensionsToken: extensionsTokenOf(probe.extensions),
  };
}

/**
 * Drives the editor handle the window open on `filePath` holds, answering
 * whether it reached one. The window draws no control for read-only, so this is
 * the only mechanism the application has for it.
 *
 * Confined to localhost, like the read above and like every call
 * `terminalDebugCapture` gates -- that module gates its reads as well as its
 * writes, and this pair follows it on both.
 * @req FR-MDE-005
 */
export function setEditorReadOnly(filePath: string, readOnly: boolean): boolean {
  if (!isLocalhostOrigin()) {
    return false;
  }

  const probe = editorWindowProbes.get(filePath);

  return probe === undefined ? false : probe.setReadOnly(readOnly);
}

// @req FR-MDE-005
function isLocalhostOrigin(): boolean {
  // Answers false rather than throwing where there is no DOM at all, so a
  // caller outside a browser is refused instead of crashed.
  if (typeof window === 'undefined') {
    return false;
  }

  return ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
}

/**
 * `filePath` and `tabId` are the window's identity and are fixed for the life of
 * a mounted instance: the save controller binds to them once, because rebuilding
 * it would drop the body it is holding. The render site keys windows by the
 * resolved absolute path, so a different file is a different instance.
 */
export interface EditorWindowProps {
  /** The normalized absolute file path. Identity of the window and the document. */
  filePath: string;
  /** The tab the window is bound to. Never a session -- that is resolved per call. */
  tabId: string;
  /** The content read from disk when the window opened. Read once, at mount. */
  bodyAtOpen: string;
  rect: DialogRect;
  onRectChange: (rect: DialogRect) => void;
  /** Drag boundary. The stage, whatever the placement. */
  boundsElement?: string | Element;
  /** The visibility predicate said no. The surface hides; nothing unmounts. */
  hidden: boolean;
  /** The window's place in the modeless stack. Carried so the shortcut can be seen to ignore it. */
  stackOrder: number;
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
   * The document started, or stopped, differing from the file it was read from.
   *
   * Reported rather than derived by the caller: the save controller inside this
   * window holds the body, and a caller could only answer the same question by
   * keeping a second copy of it.
   * @req FR-MDE-008
   */
  onDirtyChange: (dirty: boolean) => void;
  onClose: () => void;
}

/**
 * The dialog id a window on `filePath` registers under.
 *
 * Exported because raising a window from outside it -- reopening a file that is
 * already open, or reviving one from the tray -- names it by this id, and an id
 * spelled out at both ends would drift.
 * @req FR-MDE-003
 */
export function editorWindowDialogId(filePath: string): string {
  return `editor-window:${filePath}`;
}

function fileNameOf(filePath: string): string {
  const segments = filePath.split(/[\\/]/);
  return segments[segments.length - 1] || filePath;
}

/**
 * @req FR-MDE-005
 * @req FR-MDE-006
 */
export function EditorWindow({
  filePath,
  tabId,
  bodyAtOpen,
  rect,
  onRectChange,
  boundsElement,
  hidden,
  stackOrder,
  resolveTabSession,
  writeFile,
  maximized,
  onToggleMaximize,
  onMinimize,
  onClose,
  onDirtyChange,
}: EditorWindowProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLElement | null>(null);
  const shownFrameDisplayRef = useRef<string | null>(null);
  const shownSurfaceDisplayRef = useRef<string | null>(null);
  const editorHandleRef = useRef<AtomicCodeMirrorEditorHandle | null>(null);

  // The host callbacks reach the controller through refs so that the controller
  // itself is built once. Rebuilding it would drop the body it is holding.
  const resolveTabSessionRef = useRef(resolveTabSession);
  resolveTabSessionRef.current = resolveTabSession;
  const writeFileRef = useRef(writeFile);
  writeFileRef.current = writeFile;

  const [saveState, setSaveState] = useState<{ dirty: boolean; error: string | null }>({
    dirty: false,
    error: null,
  });
  const [closePrompt, setClosePrompt] = useState<EditorWindowClosePrompt>({ kind: 'none' });

  const controllerRef = useRef<EditorWindowSaveController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createEditorWindowSaveController({
      binding: { tabId, filePath },
      bodyAtOpen,
      deps: {
        resolveTabSession: (id) => resolveTabSessionRef.current(id),
        writeFile: (sessionId, path, content) => writeFileRef.current(sessionId, path, content),
      },
      onStateChange: () => {
        const controller = controllerRef.current;
        if (controller === null) return;
        setSaveState({ dirty: controller.isDirty(), error: controller.getError() });
      },
    });
  }
  const controller = controllerRef.current;

  // Captured at mount by the editor, so the reference is pinned. The five
  // callbacks of doculightExtensions are left unpassed: attachment upload and
  // wiki links stay inert, which is the intended state for this scope.
  const extensions = useMemo(() => doculightExtensions(), []);

  // The three mount-time props in one object, so the editor and the probe read
  // the same value rather than each restating the same three expressions.
  //
  // This does not make the probe an independent witness of the handoff -- a
  // prop written after the spread would still override what the probe reports.
  // Answering that needs a readback from the editor itself, which this window
  // does not have for `documentId`.
  // @req FR-MDE-005
  const editorMountProps = useMemo(() => ({
    documentId: filePath,
    markdownSource: bodyAtOpen,
    extensions,
  }), [bodyAtOpen, extensions, filePath]);

  const tabClosed = resolveTabSession(tabId) === undefined;
  const dialogId = editorWindowDialogId(filePath);

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

  // Publishes what this window is handing the editor, for a caller outside
  // React that has to read it. The three values are the ones the render below
  // passes, taken from the same expressions, so the two cannot say different
  // things about the same window.
  //
  // The disposer checks identity before deleting: a window that remounts
  // registers before the previous instance's cleanup runs, and an unconditional
  // delete would take the new registration away with it.
  // @req FR-MDE-005
  useEffect(() => {
    const probe: EditorWindowProbe = {
      ...editorMountProps,
      setReadOnly: (readOnly) => {
        const handle = editorHandleRef.current;
        if (handle === null) {
          return false;
        }

        handle.setReadOnly(readOnly);

        return true;
      },
    };

    editorWindowProbes.set(filePath, probe);

    return () => {
      if (editorWindowProbes.get(filePath) === probe) {
        editorWindowProbes.delete(filePath);
      }
    };
  }, [editorMountProps, filePath]);

  // The flag travels out on every change of its value and on no other render.
  //
  // The callback is reached through a ref rather than depended on: the render
  // site builds it inline, so depending on it would fire this on every render
  // of the window -- and each report is a state change upstream, which is the
  // next render.
  // @req FR-MDE-008
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  useEffect(() => {
    onDirtyChangeRef.current(saveState.dirty);
  }, [saveState.dirty]);

  const save = useCallback(() => {
    void controller.save();
  }, [controller]);

  // Focus decides, not stack order. The handler is per window and reads its own
  // focus state, so the window that holds the keyboard is the one that writes.
  //
  // The whole surface counts, not just the editor: the title bar, the drag
  // handle and the close button are inside the window the user is looking at,
  // and pressing the close button then cancelling must not leave the shortcut
  // dead. The refs this component owns are the fallback for the render before
  // the surface has been resolved.
  useEffect(() => {
    const handle = createEditorWindowSaveShortcutHandler({
      listWindows: () => {
        // A window whose tab has closed has no save path at all, so its press
        // is not taken from the browser either.
        if (resolveTabSessionRef.current(tabId) === undefined) {
          return [];
        }

        const active = document.activeElement;
        if (!(active instanceof Node)) {
          return [];
        }

        const surface = surfaceRef.current;
        const focused = surface !== null
          ? surface.contains(active)
          : bodyRef.current?.contains(active) === true
            || actionsRef.current?.contains(active) === true;

        return [{ documentId: filePath, focused, stackOrder }];
      },
      save: () => save(),
    });

    const onKeyDown = (event: KeyboardEvent) => handle(event);
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [filePath, save, stackOrder, tabId]);

  // A window that just opened holds no focus -- the editor does not take it on
  // mount -- so the save shortcut would be dead until the user clicked into it.
  // A window that opens hidden is left alone: focusing it would pull the
  // keyboard away from whatever the user is actually looking at.
  useEffect(() => {
    if (hidden) return;
    editorHandleRef.current?.focus();
    // Runs once: this is the opening focus, not a re-focus on every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requestClose = useCallback(() => {
    const prompt = decideEditorWindowClosePrompt({
      dirty: controller.isDirty(),
      tabClosed: resolveTabSessionRef.current(tabId) === undefined,
    });
    if (prompt.kind === 'none') {
      onClose();
      return;
    }
    setClosePrompt(prompt);
  }, [controller, onClose, tabId]);

  const answerClose = useCallback((choice: EditorWindowCloseChoice) => {
    const action = resolveEditorWindowCloseChoice(closePrompt, choice);
    setClosePrompt({ kind: 'none' });

    if (action.kind === 'close') {
      onClose();
      return;
    }
    if (action.kind === 'save-then-close') {
      void controller.save().then((outcome) => {
        if (resolveEditorWindowSaveOnClose(outcome).kind === 'close') {
          onClose();
        }
      });
    }
  }, [closePrompt, controller, onClose]);

  // The prompts render in this component's own position while the window
  // surface is portalled into document.body, so hiding the surface does not
  // reach them -- a hidden window would leave a full-screen overlay asking
  // about a document that is no longer on screen. Cancel is the safe answer.
  useEffect(() => {
    if (hidden && closePrompt.kind !== 'none') {
      setClosePrompt({ kind: 'none' });
    }
  }, [closePrompt.kind, hidden]);

  // ConfirmModal answers Escape with a cancel. The three-choice prompt below is
  // drawn here rather than by ConfirmModal, so the same key is answered here
  // and the two prompts do not disagree about what Escape means.
  useEffect(() => {
    if (closePrompt.kind !== 'unsaved-changes') return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        answerClose('cancel');
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [answerClose, closePrompt.kind]);

  const titlebarActions = (
    <div ref={actionsRef} style={ACTIONS_STYLE} className="editor-window-actions">
      {tabClosed && (
        <span style={BADGE_STYLE} title="결속된 탭이 닫혀 저장할 수 없습니다">
          저장 불가
        </span>
      )}
      <IconButton
        icon="save"
        label="저장"
        disabled={tabClosed}
        onClick={save}
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
    <>
      <WindowDialog
        dialogId={dialogId}
        title={fileNameOf(filePath)}
        mode="modeless"
        defaultRect={SUPERSEDED_DEFAULT_RECT}
        minSize={EDITOR_WINDOW_MIN_SIZE}
        onClose={requestClose}
        showCloseButton
        resizable
        persistGeometry={false}
        surfaceClassName="editor-window-surface"
        rect={rect}
        onRectChange={onRectChange}
        boundsElement={boundsElement}
        titlebarActions={titlebarActions}
        dirty={saveState.dirty}
      >
        <div ref={bodyRef} style={BODY_STYLE}>
          {saveState.error !== null && (
            <div style={BANNER_STYLE} role="alert" className="editor-window-error">
              {saveState.error}
            </div>
          )}
          {/* The vendor editor ships a light palette behind this opt-in
              (`vendor/atomic-editor/styles/inline-preview.css:767`). Setting it
              here rather than restating the palette in our own sheet keeps one
              copy of those colours. */}
          <div className="editor-window-host" style={EDITOR_HOST_STYLE} data-theme="light">
            <AtomicCodeMirrorEditor
              {...editorMountProps}
              editorHandleRef={editorHandleRef}
              onMarkdownChange={controller.handleEditorChange}
            />
          </div>
        </div>
      </WindowDialog>

      {closePrompt.kind === 'cannot-save' && (
        <ConfirmModal
          title={closePrompt.title}
          message={closePrompt.message}
          confirmLabel={closePrompt.labels.discard}
          cancelLabel={closePrompt.labels.cancel}
          destructive
          onConfirm={() => answerClose('discard')}
          onCancel={() => answerClose('cancel')}
        />
      )}

      {/* ConfirmModal renders two buttons, and this branch asks three questions:
          save, don't save, cancel. Building it by disabling a choice in the
          two-button component is exactly what the requirement rules out, so the
          three-choice prompt is drawn here over the same stylesheet. */}
      {closePrompt.kind === 'unsaved-changes' && (
        <div className="modal-overlay" onClick={() => answerClose('cancel')}>
          <div className="modal-content" onClick={(event) => event.stopPropagation()}>
            <h2 className="modal-title">{closePrompt.title}</h2>
            <p className="confirm-message">{closePrompt.message}</p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-cancel"
                onClick={() => answerClose('cancel')}
              >
                {closePrompt.labels.cancel}
              </button>
              <button
                type="button"
                className="btn-cancel btn-destructive"
                onClick={() => answerClose('discard')}
              >
                {closePrompt.labels.discard}
              </button>
              <button
                type="button"
                className="btn-submit"
                onClick={() => answerClose('save')}
              >
                {closePrompt.labels.save}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
