// One SVG tab that switches between the image viewer and its XML source.
//
// The tab opens in the viewer. The source is read on the first switch, through
// the same text read every code document uses, and from then on it follows the
// code-mode path exactly: analyzeText splits off the BOM and line ending,
// decideDocumentAccess makes a non-UTF-8 file read-only, and the save controller
// is bound with documentSaveBinding and fed encodeForSave of the editor's
// sliceDoc. Nothing here hands the raw read back to a write.
//
// Returning to the viewer draws the unsaved edit, as a Blob behind a blob: URL
// shown in an <img> -- never markup inserted into the page (SEC-MDE-001).
//
// @req FR-MDE-019
// @req FR-MDE-015
// @req FR-MDE-016
// @req SEC-MDE-001

import { analyzeText, encodeForSave, type TextLayout } from '../../editor/lineEndings.ts';
import { documentEncodingOf, documentSaveBinding } from '../../hooks/editorDocumentLoad.ts';
import { decideDocumentAccess, type DocumentAccess, type DocumentEncoding } from './editorDocumentAccess.ts';
import {
  createEditorWindowSaveController,
  type EditorWindowSaveController,
  type EditorWindowSaveDeps,
} from './editorWindowSave.ts';
import { decideEditorWindowClosePrompt, type EditorWindowClosePrompt } from './editorWindowClose.ts';
import type { BlobUrlSlot } from './imageViewerModel.ts';

export type SvgView = 'preview' | 'source';

/** The read endpoint's answer exactly as received: BOM and CRLF kept. */
export type SvgSource = { raw: string; encoding: DocumentEncoding };

export type SvgTabState = { view: SvgView; source: SvgSource | null };

/** The shape of fileApi.readFile. */
export type SvgReadFile = (sessionId: string, path: string) => Promise<{ content: string; encoding?: string }>;

export interface SvgSourceSession {
  layout: TextLayout;
  access: DocumentAccess;
  controller: EditorWindowSaveController;
  /** Takes the editor's sliceDoc() and hands the encoded body to the controller. */
  handleEditorText: (text: string) => void;
}

/**
 * @req FR-MDE-019
 */
export function initialSvgTabState(): SvgTabState {
  return { view: 'preview', source: null };
}

/**
 * Reads the source once; a loaded source is reused.
 * @req FR-MDE-019
 * @req FR-MDE-016
 */
export async function toSource(
  state: SvgTabState,
  target: { sessionId: string; filePath: string },
  deps: { readFile: SvgReadFile },
): Promise<SvgTabState> {
  if (state.source !== null) {
    return { view: 'source', source: state.source };
  }
  const file = await deps.readFile(target.sessionId, target.filePath);
  return { view: 'source', source: { raw: file.content, encoding: documentEncodingOf(file) } };
}

/**
 * A string `editorBody` redraws the preview from it; null leaves the slot alone.
 * @req FR-MDE-019
 * @req SEC-MDE-001
 */
export function toPreview(
  state: SvgTabState,
  input: { editorBody: string | null; slot: BlobUrlSlot },
): SvgTabState {
  if (input.editorBody !== null) {
    input.slot.replace(new Blob([input.editorBody], { type: 'image/svg+xml' }));
  }
  return { view: 'preview', source: state.source };
}

/**
 * The source view's save path: the same controller every code document uses.
 * @req FR-MDE-019
 * @req FR-MDE-015
 * @req FR-MDE-016
 */
export function createSvgSourceSession(input: {
  tabId: string;
  filePath: string;
  source: SvgSource;
  deps: EditorWindowSaveDeps;
  onStateChange?: () => void;
}): SvgSourceSession {
  const { tabId, filePath, source, deps, onStateChange } = input;
  const layout = analyzeText(source.raw);
  const access = decideDocumentAccess(source.encoding);
  const controller = createEditorWindowSaveController({
    binding: documentSaveBinding({ tabId, filePath, kind: 'text', encoding: source.encoding }),
    bodyAtOpen: encodeForSave(layout.body, layout),
    deps,
    onStateChange,
  });
  return {
    layout,
    access,
    controller,
    handleEditorText: (text) => controller.handleEditorChange(encodeForSave(text, layout)),
  };
}

/**
 * @req FR-MDE-019
 */
export function svgTabClosePrompt(
  session: Pick<SvgSourceSession, 'controller'>,
  input: { tabClosed: boolean },
): EditorWindowClosePrompt {
  return decideEditorWindowClosePrompt({ dirty: session.controller.isDirty(), tabClosed: input.tabClosed });
}
