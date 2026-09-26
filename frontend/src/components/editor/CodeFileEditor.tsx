// The editor for source and data files -- a sibling of the vendored markdown
// editor, not a mode inside it, so the vendor files stay untouched.
//
// It keeps the markdown editor's mount contract: the initial text is read once
// per `documentId` and the view owns the document afterwards (no controlled
// value). Its handle has the same shape as AtomicCodeMirrorEditorHandle, so the
// document panel drives either editor the same way.
//
// The grammar arrives after mount: the view opens as plain text and the
// language compartment is reconfigured once languages.ts has loaded it. Line
// wrap lives in its own compartment and follows the `wrap` prop in place.
//
// @req FR-MDE-014

import { useEffect, useRef, type MutableRefObject } from 'react';
import { redo, undo } from '@codemirror/commands';
import {
  SearchQuery,
  closeSearchPanel,
  openSearchPanel,
  searchPanelOpen,
  setSearchQuery,
} from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { AtomicCodeMirrorEditorHandle } from '../../editor';
import {
  buildCodeEditorExtensions,
  languageExtension,
  loadLanguageSupport,
  wrapExtension,
} from './codeEditorExtensions.ts';
import type { DataFileKind } from './dataFileLint.ts';
import type { ColumnDelimiter } from './csvColumns.ts';

const EMPTY_EXTENSIONS: readonly Extension[] = [];

function readOnlyExtension(readOnly: boolean): Extension {
  return [EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)];
}

export interface CodeFileEditorProps {
  /** Identity of the document; a new value remounts the view. */
  documentId?: string;
  /** The initial text, read at mount only. Named as the markdown editor names it. */
  markdownSource: string;
  /** Language id from resolveEditorMode; null edits as plain text. */
  language: string | null;
  /** Soft-wrap long lines. Toggling reconfigures in place. */
  wrap?: boolean;
  readOnly?: boolean;
  /** JSON/JSONL/YAML diagnostics, read at mount (FR-MDE-017). */
  dataFile?: DataFileKind | null;
  /** CSV/TSV column colouring, read at mount (FR-MDE-017). */
  columnDelimiter?: ColumnDelimiter | null;
  onMarkdownChange?: (text: string) => void;
  editorHandleRef?: MutableRefObject<AtomicCodeMirrorEditorHandle | null>;
  /** Captured at mount, like the markdown editor's `extensions`. */
  extensions?: readonly Extension[];
}

export function CodeFileEditor({
  documentId,
  markdownSource,
  language,
  wrap = false,
  readOnly = false,
  dataFile = null,
  columnDelimiter = null,
  onMarkdownChange,
  editorHandleRef,
  extensions = EMPTY_EXTENSIONS,
}: CodeFileEditorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const wrapCompartmentRef = useRef(new Compartment());
  const languageCompartmentRef = useRef(new Compartment());
  const readOnlyCompartmentRef = useRef(new Compartment());
  const onChangeRef = useRef(onMarkdownChange);
  // Latest values for the mount effect, which must not list them: changing
  // them reconfigures the view rather than rebuilding it.
  const wrapRef = useRef(wrap);
  wrapRef.current = wrap;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const dataFileRef = useRef(dataFile);
  dataFileRef.current = dataFile;
  const columnDelimiterRef = useRef(columnDelimiter);
  columnDelimiterRef.current = columnDelimiter;

  useEffect(() => {
    onChangeRef.current = onMarkdownChange;
  }, [onMarkdownChange]);

  const editorIdentity = documentId ?? markdownSource;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const bundle = buildCodeEditorExtensions({
      wrap: wrapRef.current,
      language: null,
      wrapCompartment: wrapCompartmentRef.current,
      languageCompartment: languageCompartmentRef.current,
      dataFile: dataFileRef.current,
      columnDelimiter: columnDelimiterRef.current,
    });
    const view = new EditorView({
      parent: root,
      state: EditorState.create({
        doc: markdownSource,
        extensions: [
          ...bundle.extensions,
          readOnlyCompartmentRef.current.of(readOnlyExtension(readOnlyRef.current)),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            onChangeRef.current?.(update.state.doc.toString());
          }),
          ...extensions,
        ],
      }),
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorIdentity]);

  // The grammar for this document; a stale load for a previous document or
  // language is dropped rather than applied to whatever view is current.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let cancelled = false;
    view.dispatch({ effects: languageCompartmentRef.current.reconfigure(languageExtension(null)) });
    void loadLanguageSupport(language).then((support) => {
      if (cancelled || viewRef.current !== view || support === null) return;
      view.dispatch({ effects: languageCompartmentRef.current.reconfigure(languageExtension(support)) });
    });
    return () => {
      cancelled = true;
    };
  }, [editorIdentity, language]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: wrapCompartmentRef.current.reconfigure(wrapExtension(wrap)) });
  }, [wrap]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartmentRef.current.reconfigure(readOnlyExtension(readOnly)),
    });
  }, [readOnly]);

  useEffect(() => {
    if (!editorHandleRef) return;
    editorHandleRef.current = {
      focus: () => viewRef.current?.focus(),
      undo: () => {
        const view = viewRef.current;
        if (view) undo(view);
      },
      redo: () => {
        const view = viewRef.current;
        if (view) redo(view);
      },
      openSearch: (query) => {
        const view = viewRef.current;
        if (!view) return;
        if (query !== undefined) {
          view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: query })) });
        }
        openSearchPanel(view);
      },
      closeSearch: () => {
        const view = viewRef.current;
        if (view) closeSearchPanel(view);
      },
      revealText: (query) => {
        const view = viewRef.current;
        if (!view || !query) return;
        const from = view.state.doc.toString().indexOf(query);
        if (from < 0) return;
        view.dispatch({ effects: EditorView.scrollIntoView(from, { y: 'start', yMargin: 72 }) });
      },
      isSearchOpen: () => {
        const view = viewRef.current;
        return view ? searchPanelOpen(view.state) : false;
      },
      getMarkdown: () => viewRef.current?.state.doc.toString() ?? '',
      getContentDOM: () => viewRef.current?.contentDOM ?? null,
      setReadOnly: (next) => {
        viewRef.current?.dispatch({
          effects: readOnlyCompartmentRef.current.reconfigure(readOnlyExtension(next)),
        });
      },
    };
    return () => {
      if (editorHandleRef.current) editorHandleRef.current = null;
    };
  }, [editorHandleRef]);

  // `atomic-cm-editor` picks up the vendored stylesheet's colour variables,
  // including its light palette under the panel's data-theme="light".
  return <div ref={rootRef} className="atomic-cm-editor code-file-editor" />;
}
