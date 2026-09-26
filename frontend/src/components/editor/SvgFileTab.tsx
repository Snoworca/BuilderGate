// One SVG tab: the image viewer and the XML source editor, switched in place.
//
// The panel owns the save controller the title bar and Ctrl+S drive, so the
// source session is built through `openSession` -- the panel creates it with
// its own deps and repaints on its state changes. This component only decides
// which view is on screen and feeds the editor's sliceDoc() to that session.
//
// Both views stay mounted once shown and are hidden with `display: none`, so
// switching back and forth never throws away the unsaved source.
//
// @req FR-MDE-019
// @req FR-MDE-015
// @req FR-MDE-016
// @req SEC-MDE-001

import { useCallback, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { AtomicCodeMirrorEditorHandle } from '../../editor';
import { fileApi } from '../../services/api';
import type { ImageDocumentState } from '../../hooks/editorDocumentLoad.ts';
import { CodeFileEditor } from './CodeFileEditor.tsx';
import { ImageFileViewer } from './ImageFileViewer.tsx';
import { WrapIcon } from './EditorDocumentToolbar.tsx';
import { lineEndingLabel } from './editorDocumentAccess.ts';
import { normalizeInsertedLineBreaks } from '../../editor/lineEndings.ts';
import type { BlobUrlSlot } from './imageViewerModel.ts';
import {
  initialSvgTabState,
  toPreview,
  toSource,
  type SvgReadFile,
  type SvgSource,
  type SvgSourceSession,
  type SvgTabState,
} from './svgTabModel.ts';

export interface SvgFileTabProps {
  filePath: string;
  tabId: string;
  /** The image read the tab opened with. */
  image: ImageDocumentState | null;
  resolveTabSession: (tabId: string) => string | undefined;
  /** Builds (once) the source session the panel's controller follows. */
  openSession: (source: SvgSource) => SvgSourceSession;
  wrap: boolean;
  onToggleWrap: () => void;
  editorHandleRef?: MutableRefObject<AtomicCodeMirrorEditorHandle | null>;
  /** Defaults to fileApi.readFile. */
  readFile?: SvgReadFile;
}

const FILL_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  minHeight: 0,
  height: '100%',
};

const HIDDEN_STYLE: CSSProperties = { ...FILL_STYLE, display: 'none' };

// The source toolbar, the notice and the line-ending line are drawn by the
// editor window's classes (EditorWindow.css), the same ones the document panel
// uses, so an SVG's source view looks like any other code document.
const EDITOR_STYLE: CSSProperties = { flex: '1 1 auto', minHeight: 0, overflow: 'auto' };

const SOURCE_READ_FAILED = 'SVG 소스를 읽지 못했습니다.';

/**
 * ImageFileViewer owns the blob: URL of whatever Blob it is given, so the
 * model's slot here only captures the Blob for it; the viewer creates and
 * revokes the URL.
 */
function blobCaptureSlot(onBlob: (blob: Blob) => void): BlobUrlSlot {
  return {
    replace(blob) {
      onBlob(blob);
      return '';
    },
    current: () => null,
    dispose: () => undefined,
  };
}

// @req FR-MDE-019
export function SvgFileTab({
  filePath,
  tabId,
  image,
  resolveTabSession,
  openSession,
  wrap,
  onToggleWrap,
  editorHandleRef,
  readFile = fileApi.readFile,
}: SvgFileTabProps) {
  const [tabState, setTabState] = useState<SvgTabState>(initialSvgTabState);
  const [session, setSession] = useState<SvgSourceSession | null>(null);
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(
    image?.status === 'ready' ? image.blob : null,
  );
  const [sourceError, setSourceError] = useState<string | null>(null);
  // A ref, not state: two clicks in one tick must not both start a read.
  const loadingRef = useRef(false);
  // The editor text since the preview was last drawn; null when unchanged.
  const pendingEditRef = useRef<string | null>(null);

  const showSource = useCallback(async () => {
    if (loadingRef.current) return;
    const sessionId = resolveTabSession(tabId);
    if (sessionId === undefined && tabState.source === null) {
      setSourceError(SOURCE_READ_FAILED);
      return;
    }
    loadingRef.current = true;
    try {
      const next = await toSource(tabState, { sessionId: sessionId ?? '', filePath }, { readFile });
      if (next.source !== null && session === null) {
        setSession(openSession(next.source));
      }
      setSourceError(null);
      setTabState(next);
    } catch (error) {
      setSourceError(error instanceof Error && error.message.length > 0 ? error.message : SOURCE_READ_FAILED);
    } finally {
      loadingRef.current = false;
    }
  }, [filePath, openSession, readFile, resolveTabSession, session, tabId, tabState]);

  const showPreview = useCallback(() => {
    const editorBody = pendingEditRef.current;
    pendingEditRef.current = null;
    setTabState((prev) => toPreview(prev, { editorBody, slot: blobCaptureSlot(setPreviewBlob) }));
  }, []);

  // Same two extensions as every code document: the file's own line ending,
  // and a listener that is the only source of the save body.
  // @req FR-MDE-015
  const extensions = useMemo(() => {
    if (session === null) return [];
    return [
      EditorState.lineSeparator.of(session.layout.eol),
      normalizeInsertedLineBreaks(session.layout.eol),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const text = update.state.sliceDoc();
        pendingEditRef.current = text;
        session.handleEditorText(text);
      }),
    ];
  }, [session]);

  const inSource = tabState.view === 'source';
  const readError = previewBlob === null && image?.status === 'error' ? image.error : null;

  return (
    <div style={FILL_STYLE} className="svg-file-tab" data-svg-view={tabState.view}>
      {sourceError !== null && (
        <div role="alert" className="svg-file-tab-error">
          {sourceError}
        </div>
      )}
      <div style={inSource ? HIDDEN_STYLE : FILL_STYLE}>
        <ImageFileViewer
          blob={previewBlob}
          size={previewBlob?.size ?? 0}
          error={readError}
          onEditSource={() => { void showSource(); }}
        />
      </div>
      {session !== null && (
        <div style={inSource ? FILL_STYLE : HIDDEN_STYLE} className="svg-file-tab-source">
          <div className="editor-code-toolbar">
            <button
              type="button"
              className="editor-toolbar-button editor-code-wrap-toggle"
              aria-pressed={wrap}
              title={wrap ? '줄 바꿈 끄기' : '줄 바꿈 켜기'}
              aria-label="줄 바꿈"
              onClick={onToggleWrap}
            >
              {/* @req FR-MDE-020 -- the same wrap icon as the document toolbar. */}
              <WrapIcon />
            </button>
            <button
              type="button"
              className="editor-text-button svg-file-tab-preview"
              onClick={showPreview}
            >
              미리보기
            </button>
          </div>
          {session.access.notice !== null && (
            <div role="status" className="editor-document-notice">
              {session.access.notice}
            </div>
          )}
          <div style={EDITOR_STYLE}>
            <CodeFileEditor
              documentId={filePath}
              markdownSource={session.layout.body}
              extensions={extensions}
              language="xml"
              wrap={wrap}
              readOnly={session.access.readOnly}
              editorHandleRef={editorHandleRef}
            />
          </div>
          <div
            className="editor-document-status"
            data-line-ending={lineEndingLabel(session.layout.eol)}
          >
            {lineEndingLabel(session.layout.eol)}
          </div>
        </div>
      )}
    </div>
  );
}
