// One document inside the editor window: the ported editor, its save
// controller, its error banner and its close prompts.
//
// Two mount-time contracts of the editor decide most of what happens here.
// `markdownSource` is read once and the editor owns the document from then on,
// so the body is never fed back on a keystroke or after a save. `documentId` is
// the normalized absolute file path rather than the session id, because a tab
// restart replaces the session while keeping the file -- an id derived from the
// session would destroy and recreate the EditorView and take the unsaved body
// with it. `extensions` is captured at mount too, so its reference is pinned.
//
// The body the save controller holds is never doc.toString(): that joins lines
// with "\n" and would rewrite every CRLF on save. The editor is told the file's
// own line ending, the save body is read with state.sliceDoc() by a listener
// among the extensions, and the BOM the file opened with is put back.
//
// A panel is never unmounted to hide it. Several documents are open in one
// window and only one is on screen; the others keep their editor instances and
// whatever the user has typed into them, and are hidden with `display: none`.
// Tearing one down to save a few nodes would throw that body away.
//
// @req FR-MDE-005
// @req FR-MDE-006
// @req CON-MDE-002
// @req FR-MDE-015
// @req FR-MDE-016
//
// The file's editor mode is fixed at mount from its path: markdown files get
// the vendored editor, source and data files the sibling CodeFileEditor. Both
// take the same mount-time props, handle and save controller, so save, dirty,
// close prompts, line endings and read-only behave the same in either mode.
// @req FR-MDE-014

import { editorPhrases } from '../../i18n/editorPhrases.ts';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { AtomicCodeMirrorEditor, doculightExtensions } from '../../editor';
import type { AtomicCodeMirrorEditorHandle } from '../../editor';
import { analyzeText, encodeForSave, normalizeInsertedLineBreaks } from '../../editor/lineEndings.ts';
import { resolveEditorMode } from '../../editor/editorMode.ts';
import { CodeFileEditor } from './CodeFileEditor.tsx';
import { ImageFileViewer } from './ImageFileViewer.tsx';
import { SvgFileTab } from './SvgFileTab.tsx';
import { createSvgSourceSession, type SvgSource, type SvgSourceSession } from './svgTabModel.ts';
import { documentSaveBinding, type ImageDocumentState } from '../../hooks/editorDocumentLoad.ts';
import { readWrapPreference, writeWrapPreference } from './codeEditorExtensions.ts';
import { EditorDocumentToolbar } from './EditorDocumentToolbar.tsx';
import { useEditorTheme } from './useEditorTheme.ts';
import {
  buildEditorEditMenuItems,
  editorViewFromContent,
  hasEditorSelection,
  runEditorEditCommand,
  type EditorEditCommand,
} from './editorEditMenu.ts';
import { ContextMenu } from '../ContextMenu/ContextMenu';
import { useLongPress } from '../../hooks/useLongPress.ts';
import type { EditorPaneToggle } from './EditorDocumentToolbar.tsx';
import { effectiveDocumentComponent, selectDocumentComponent } from './editorDocumentMode.ts';
import { dataFileKindFor } from './dataFileLint.ts';
import { columnDelimiterFor } from './csvColumns.ts';
import { ConfirmModal } from '../Modal/ConfirmModal';
import '../Modal/ConfirmModal.css';
// The three-choice prompt below is drawn here rather than by ConfirmModal, and
// its rules are split across the two sheets: the overlay, panel, title and the
// two plain buttons come from RenameModal.css, while the message and the
// destructive button come from ConfirmModal.css above. Both are imported here so
// the prompt's appearance does not rest on some other component still importing
// one of them somewhere else in the graph.
import '../Modal/RenameModal.css';
import {
  createEditorWindowSaveController,
  type EditorWindowSaveController,
} from './editorWindowSave.ts';
import {
  decideDocumentAccess,
  lineEndingLabel,
  type DocumentEncoding,
} from './editorDocumentAccess.ts';
import {
  decideEditorWindowClosePrompt,
  resolveEditorWindowCloseChoice,
  resolveEditorWindowSaveOnClose,
  type EditorWindowCloseChoice,
  type EditorWindowClosePrompt,
} from './editorWindowClose.ts';

const BODY_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  height: '100%',
};

const HIDDEN_BODY_STYLE: CSSProperties = { ...BODY_STYLE, display: 'none' };

// The read-only notice (FR-MDE-016), the line-ending line (FR-MDE-015) and the
// save error banner are drawn by classes in `EditorWindow.css` that read the
// surface tokens, so none of them introduces a colour or a size of its own.

// Tells every mounted panel that the global wrap preference changed.
const WRAP_CHANGE_EVENT = 'buildergate:code-editor-wrap-change';

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

// Everything that is not markdown fills the editing area rather than sitting
// in a centred column (FR-MDE-020 AC-1).
// @req FR-MDE-020
const FULL_HOST_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minHeight: 0,
  overflow: 'auto',
};

/**
 * What a mounted panel is handing the editor, kept so a caller outside React
 * can read it. `extensions` is held as the array object rather than its
 * contents, because what has to be observable is whether the reference changed.
 * @req FR-MDE-005
 */
interface EditorDocumentProbe {
  documentId: string;
  markdownSource: string;
  extensions: object;
  setReadOnly: (readOnly: boolean) => boolean;
}

/**
 * Keyed by file path, which is what identifies a document here. Several
 * documents are open at once, so a single set of values would answer for
 * whichever of them mounted last rather than for the one being asked about.
 * @req FR-MDE-005
 */
const editorDocumentProbes = new Map<string, EditorDocumentProbe>();

/**
 * One number per `extensions` array object, so equal numbers mean the same
 * array. A WeakMap rather than a field written onto the array: the numbering
 * must not keep a closed document's extensions alive, and must not write to a
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
 * What the panel holding `filePath` is passing to the editor, or undefined when
 * no panel holds it. An absent panel answers `undefined` rather than empty
 * values, so "not open" and "open and passing nothing" stay apart.
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

  const probe = editorDocumentProbes.get(filePath);
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
 * Drives the editor handle the panel holding `filePath` owns, answering whether
 * it reached one. No control draws read-only, so this is the only mechanism the
 * application has for it.
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

  const probe = editorDocumentProbes.get(filePath);

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
 * What the window drives a panel with. The window owns the title bar, so the
 * buttons there act on the active panel through this rather than by reaching
 * into it.
 */
export interface EditorDocumentHandle {
  /** Writes the document. The controller decides whether there is anything to write. */
  save: () => void;
  /** Asks to close this document, which may put a prompt on screen first. */
  requestClose: () => void;
  /** Whether the document differs from the file it was read from. */
  isDirty: () => boolean;
  /**
   * Saves for a batch close (FR-MDE-021 AC-5): resolves true when the document
   * may now close -- saved, or nothing to save -- and false when the save
   * failed, whose error the panel shows.
   */
  saveForClose: () => Promise<boolean>;
}

export interface EditorDocumentPanelProps {
  /** The normalized absolute file path. Identity of the document and the tab. */
  filePath: string;
  /** The terminal tab this document saves to. Never a session -- that is resolved per call. */
  tabId: string;
  /** The content read from disk when the document opened. Read once, at mount. */
  bodyAtOpen: string;
  /**
   * What the read reported, read once at mount like the body. `unknown` makes
   * the document read-only.
   * @req FR-MDE-016
   */
  encoding: DocumentEncoding;
  /**
   * An image tab's bytes or read failure, read at mount; null for text.
   * @req FR-MDE-018
   */
  image?: ImageDocumentState | null;
  /**
   * This document is not the one on screen: its tab is not active, or the
   * window itself is hidden. The subtree stays mounted either way.
   * @req FR-MDE-002
   */
  hidden: boolean;
  resolveTabSession: (tabId: string) => string | undefined;
  writeFile: (sessionId: string, path: string, content: string) => Promise<{ success: boolean }>;
  /**
   * The document started, or stopped, differing from the file it was read from.
   *
   * Reported rather than derived by the caller: the save controller inside this
   * panel holds the body, and a caller could only answer the same question by
   * keeping a second copy of it.
   * @req FR-MDE-008
   */
  onDirtyChange: (dirty: boolean) => void;
  /** The document is to be closed. Its tab goes; the window may go with it. */
  onClose: () => void;
  /**
   * Hands the window this panel's controls, and takes them back on unmount.
   *
   * Registered rather than lifted: the save controller lives here because it
   * holds the body, and the window needs to drive it from a title bar it owns.
   */
  onRegisterHandle: (filePath: string, handle: EditorDocumentHandle | null) => void;
  /** The window's file tree toggle, drawn in this document's toolbar (FR-MDE-020 AC-8). */
  paneToggle?: EditorPaneToggle;
}

/**
 * @req FR-MDE-005
 * @req FR-MDE-006
 * @req FR-MDE-015
 * @req FR-MDE-016
 */
export function EditorDocumentPanel({
  filePath,
  tabId,
  bodyAtOpen,
  encoding,
  image = null,
  hidden,
  resolveTabSession,
  writeFile,
  onDirtyChange,
  onClose,
  onRegisterHandle,
  paneToggle,
}: EditorDocumentPanelProps) {
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

  // `bodyAtOpen` is read once, like the editor's `markdownSource`, so its line
  // ending and BOM are fixed for the life of the panel. The editor gets the
  // body without the BOM; the controller keeps the bytes as they are on disk,
  // so the dirty basis and every saved body are in the same, encoded, form.
  // @req FR-MDE-015
  const layoutRef = useRef<ReturnType<typeof analyzeText> | null>(null);
  if (layoutRef.current === null) {
    layoutRef.current = analyzeText(bodyAtOpen);
  }
  const layout = layoutRef.current;

  // Fixed at mount with the body it describes: the encoding belongs to the
  // bytes that were read, and those do not change while the panel lives.
  // @req FR-MDE-016
  const accessRef = useRef<ReturnType<typeof decideDocumentAccess> | null>(null);
  if (accessRef.current === null) {
    accessRef.current = decideDocumentAccess(encoding);
  }
  const access = accessRef.current;

  // The path does not change while the panel lives, so neither does the mode.
  // @req FR-MDE-014
  const modeRef = useRef<ReturnType<typeof resolveEditorMode> | null>(null);
  if (modeRef.current === null) {
    modeRef.current = resolveEditorMode(filePath);
  }
  const mode = modeRef.current;
  const component = selectDocumentComponent(mode.kind);

  // A markdown document can be shown as raw source in the code editor
  // (FR-MDE-023). `view` is what is drawn; `component` stays the file's kind.
  // Switching remounts the editor with the text being edited, which the save
  // listener keeps in liveBodyRef; the one save controller carries dirty and
  // the save across the switch.
  // @req FR-MDE-023
  const [raw, setRaw] = useState(false);
  const view = effectiveDocumentComponent(component, raw);
  const shown = component === 'markdown' && raw ? 'markdown-raw' : component;
  const liveBodyRef = useRef(layout.body);
  const [mountBody, setMountBody] = useState(layout.body);
  const toggleRaw = useCallback(() => {
    setMountBody(liveBodyRef.current);
    setRaw(current => !current);
  }, []);

  // Global user preference, not part of the document (FR-MDE-014 AC-3).
  // @req FR-MDE-014
  // Every open code document follows a toggle made in any of them.
  // @req FR-MDE-014
  const [wrap, setWrap] = useState<boolean>(() => readWrapPreference());
  useEffect(() => {
    const onWrapChange = (event: Event) => {
      setWrap((event as CustomEvent<boolean>).detail);
    };
    window.addEventListener(WRAP_CHANGE_EVENT, onWrapChange);
    return () => window.removeEventListener(WRAP_CHANGE_EVENT, onWrapChange);
  }, []);
  const toggleWrap = useCallback(() => {
    const next = !wrap;
    writeWrapPreference(next);
    window.dispatchEvent(new CustomEvent<boolean>(WRAP_CHANGE_EVENT, { detail: next }));
  }, [wrap]);

  // The light/dark choice is global and stored like the wrap preference, and
  // every open document follows a toggle made in any of them.
  // @req FR-MDE-020
  const [theme, toggleTheme] = useEditorTheme();

  const controllerRef = useRef<EditorWindowSaveController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createEditorWindowSaveController({
      // An image tab is view-only: it never turns dirty and its save writes
      // nothing, through the same controller the title bar and Ctrl+S call.
      // @req FR-MDE-018
      binding: documentSaveBinding({ tabId, filePath, kind: component === 'image' ? 'image' : 'text', encoding }),
      bodyAtOpen: encodeForSave(layout.body, layout),
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

  // An SVG tab can switch to its XML source (FR-MDE-019). That source has its
  // own controller -- bound as text, on the code-mode save path -- and once it
  // exists the title bar, Ctrl+S, dirty and the close prompt all follow it.
  // @req FR-MDE-019
  const isSvg = component === 'image' && filePath.toLowerCase().endsWith('.svg');
  const svgSessionRef = useRef<SvgSourceSession | null>(null);
  const activeController = useCallback(
    (): EditorWindowSaveController => svgSessionRef.current?.controller ?? controller,
    [controller],
  );
  const openSvgSession = useCallback((source: SvgSource): SvgSourceSession => {
    if (svgSessionRef.current !== null) return svgSessionRef.current;
    const session = createSvgSourceSession({
      tabId,
      filePath,
      source,
      deps: {
        resolveTabSession: (id) => resolveTabSessionRef.current(id),
        writeFile: (sessionId, path, content) => writeFileRef.current(sessionId, path, content),
      },
      onStateChange: () => {
        const svgController = svgSessionRef.current?.controller;
        if (svgController === undefined) return;
        setSaveState({ dirty: svgController.isDirty(), error: svgController.getError() });
      },
    });
    svgSessionRef.current = session;
    return session;
  }, [filePath, tabId]);

  // Captured at mount by the editor, so the reference is pinned. The five
  // callbacks of doculightExtensions are left unpassed: attachment upload and
  // wiki links stay inert, which is the intended state for this scope.
  //
  // The line separator and the save listener ride here too, so the vendor
  // editor is extended rather than edited. The listener is the only source of
  // the save body: sliceDoc() joins lines with the file's own ending. Code mode
  // takes the same two without the markdown extensions (FR-MDE-014 AC-2).
  // @req FR-MDE-015
  // @req FR-MDE-014
  const extensions = useMemo(() => [
    ...(view === 'markdown' ? doculightExtensions() : []),
    editorPhrases(), // FR-I18N-003 AC-3: CodeMirror and vendor panel text from the catalog
    EditorState.lineSeparator.of(layout.eol),
    normalizeInsertedLineBreaks(layout.eol),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      liveBodyRef.current = update.state.sliceDoc();
      controllerRef.current?.handleEditorChange(encodeForSave(liveBodyRef.current, layout));
    }),
  ], [view, layout]);

  // The three mount-time props in one object, so the editor and the probe read
  // the same value rather than each restating the same three expressions.
  //
  // This does not make the probe an independent witness of the handoff -- a
  // prop written after the spread would still override what the probe reports.
  // Answering that needs a readback from the editor itself, which this panel
  // does not have for `documentId`.
  // @req FR-MDE-005
  const editorMountProps = useMemo(() => ({
    documentId: filePath,
    markdownSource: mountBody,
    extensions,
  }), [extensions, filePath, mountBody]);

  // Publishes what this panel is handing the editor, for a caller outside React
  // that has to read it. The three values are the ones the render below passes,
  // taken from the same expressions, so the two cannot say different things
  // about the same document.
  //
  // The disposer checks identity before deleting: a panel that remounts
  // registers before the previous instance's cleanup runs, and an unconditional
  // delete would take the new registration away with it.
  // @req FR-MDE-005
  useEffect(() => {
    const probe: EditorDocumentProbe = {
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

    editorDocumentProbes.set(filePath, probe);

    return () => {
      if (editorDocumentProbes.get(filePath) === probe) {
        editorDocumentProbes.delete(filePath);
      }
    };
  }, [editorMountProps, filePath]);

  // The document body's own menu (FR-MDE-022): 모두 선택 · 복사 · 잘라내기 ·
  // 붙여넣기, on right click and, on a phone, on a long press. Only a click that
  // lands in a CodeMirror editor opens it -- the image viewer keeps the default.
  // @req FR-MDE-022
  const [editMenu, setEditMenu] = useState<{ x: number; y: number; view: EditorView } | null>(null);
  const openEditMenuAt = useCallback((target: EventTarget | null, x: number, y: number): boolean => {
    const editor = target instanceof Element ? target.closest('.cm-editor') : null;
    const view = editorViewFromContent(editor?.querySelector<HTMLElement>('.cm-content') ?? null);
    if (view === null) return false;
    setEditMenu({ x, y, view });
    return true;
  }, []);
  const openEditMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (openEditMenuAt(event.target, event.clientX, event.clientY)) event.preventDefault();
  }, [openEditMenuAt]);
  const editLongPress = useLongPress((point) => {
    openEditMenuAt(document.elementFromPoint(point.clientX, point.clientY), point.clientX, point.clientY);
  });
  const runEdit = useCallback((command: EditorEditCommand) => {
    const view = editMenu?.view;
    if (view === undefined) return;
    void runEditorEditCommand(view, command, navigator.clipboard);
  }, [editMenu]);
  const editMenuItems = editMenu === null ? [] : buildEditorEditMenuItems({
    hasSelection: hasEditorSelection(editMenu.view.state),
    readOnly: editMenu.view.state.readOnly,
    onSelectAll: () => runEdit('selectAll'),
    onCopy: () => runEdit('copy'),
    onCut: () => runEdit('cut'),
    onPaste: () => runEdit('paste'),
  });

  // The flag travels out on every change of its value and on no other render.
  //
  // The callback is reached through a ref rather than depended on: the render
  // site builds it inline, so depending on it would fire this on every render
  // of the panel -- and each report is a state change upstream, which is the
  // next render.
  // @req FR-MDE-008
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  useEffect(() => {
    onDirtyChangeRef.current(saveState.dirty);
  }, [saveState.dirty]);

  const save = useCallback(() => {
    void activeController().save();
  }, [activeController]);

  const requestClose = useCallback(() => {
    const prompt = decideEditorWindowClosePrompt({
      dirty: activeController().isDirty(),
      tabClosed: resolveTabSessionRef.current(tabId) === undefined,
    });
    if (prompt.kind === 'none') {
      onClose();
      return;
    }
    setClosePrompt(prompt);
  }, [activeController, onClose, tabId]);

  const answerClose = useCallback((choice: EditorWindowCloseChoice) => {
    const action = resolveEditorWindowCloseChoice(closePrompt, choice);
    setClosePrompt({ kind: 'none' });

    if (action.kind === 'close') {
      onClose();
      return;
    }
    if (action.kind === 'save-then-close') {
      void activeController().save().then((outcome) => {
        if (resolveEditorWindowSaveOnClose(outcome).kind === 'close') {
          onClose();
        }
      });
    }
  }, [activeController, closePrompt, onClose]);

  // The window drives this panel through the handle rather than through props
  // of its own, so the title bar acts on whichever document is active without
  // the window holding a copy of any of it.
  //
  // The registration is keyed by path and withdrawn on unmount, and the
  // withdrawal is what stops a closed document's controls from being reachable.
  const onRegisterHandleRef = useRef(onRegisterHandle);
  onRegisterHandleRef.current = onRegisterHandle;

  useEffect(() => {
    onRegisterHandleRef.current(filePath, {
      save,
      requestClose,
      isDirty: () => activeController().isDirty(),
      saveForClose: () => activeController().save().then(
        (outcome) => resolveEditorWindowSaveOnClose(outcome).kind === 'close',
      ),
    });

    return () => onRegisterHandleRef.current(filePath, null);
  }, [activeController, filePath, requestClose, save]);

  // A document that just opened holds no focus -- the editor does not take it
  // on mount -- so the save shortcut would be dead until the user clicked into
  // it. One that opens hidden is left alone: focusing it would pull the
  // keyboard away from whatever the user is actually looking at.
  useEffect(() => {
    if (hidden) return;
    editorHandleRef.current?.focus();
    // Runs once: this is the opening focus, not a re-focus on every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The prompts render in this component's own position while the window
  // surface is portalled into document.body, so hiding the surface does not
  // reach them -- a hidden document would leave a full-screen overlay asking
  // about something that is no longer on screen. Cancel is the safe answer.
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

  return (
    <>
      <div
        style={hidden ? HIDDEN_BODY_STYLE : BODY_STYLE}
        className="editor-document-panel"
        data-document-id={filePath}
        data-editor-theme={theme}
        data-surface={theme === 'light' ? 'paper' : undefined}
      >
        {/* @req FR-MDE-020 -- path, light/dark toggle, and (code only) wrap toggle. */}
        <EditorDocumentToolbar
          filePath={filePath}
          theme={theme}
          onToggleTheme={toggleTheme}
          wrap={wrap}
          onToggleWrap={view === 'code' ? toggleWrap : undefined}
          paneToggle={paneToggle}
          markdownView={component === 'markdown' ? { raw, onToggle: toggleRaw } : undefined}
        />
        {saveState.error !== null && (
          <div role="alert" className="editor-window-error">
            {saveState.error}
          </div>
        )}
        {access.notice !== null && (
          <div role="status" className="editor-document-notice">
            {access.notice}
          </div>
        )}
        {/* The vendor editor ships a light palette behind the `light` opt-in
            (`vendor/atomic-editor/styles/inline-preview.css:767`) and its dark
            one as the default, so the theme is chosen here rather than by
            restating either palette in our own sheet. */}
        <div
          className="editor-window-host"
          style={view === 'markdown' ? EDITOR_HOST_STYLE : FULL_HOST_STYLE}
          data-theme={theme}
          onContextMenu={openEditMenu}
          onTouchStart={editLongPress.onTouchStart}
          onTouchMove={editLongPress.onTouchMove}
          onTouchEnd={editLongPress.onTouchEnd}
          data-editor-mode={view ?? 'none'}
        >
          {view === 'markdown' && (
            <AtomicCodeMirrorEditor
              {...editorMountProps}
              readOnly={access.readOnly}
              editorHandleRef={editorHandleRef}
            />
          )}
          {view === 'code' && (
            <CodeFileEditor
              key={shown ?? 'code'}
              {...editorMountProps}
              language={shown === 'markdown-raw' ? 'markdown' : mode.language}
              wrap={wrap}
              readOnly={access.readOnly}
              dataFile={dataFileKindFor(filePath)}
              columnDelimiter={columnDelimiterFor(filePath)}
              editorHandleRef={editorHandleRef}
            />
          )}
          {/* @req FR-MDE-018 -- an image draws in the viewer; a non-editor
              file opens nothing rather than binary text. */}
          {/* @req FR-MDE-019 -- an SVG switches between viewer and source. */}
          {isSvg && (
            <SvgFileTab
              filePath={filePath}
              tabId={tabId}
              image={image}
              resolveTabSession={(id) => resolveTabSessionRef.current(id)}
              openSession={openSvgSession}
              wrap={wrap}
              onToggleWrap={toggleWrap}
              editorHandleRef={editorHandleRef}
            />
          )}
          {component === 'image' && !isSvg && (
            <ImageFileViewer
              blob={image?.status === 'ready' ? image.blob : null}
              size={image?.status === 'ready' ? image.size : 0}
              error={image?.status === 'error' ? image.error : null}
            />
          )}
        </div>
        {component !== 'image' && (
          <div className="editor-document-status" data-line-ending={lineEndingLabel(layout.eol)}>
            {lineEndingLabel(layout.eol)}
          </div>
        )}
      </div>

      {editMenu !== null && (
        <ContextMenu position={{ x: editMenu.x, y: editMenu.y }} items={editMenuItems} onClose={() => setEditMenu(null)} />
      )}

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
