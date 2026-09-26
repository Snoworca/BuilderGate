// How a path becomes an open document: the read, what its answer means, and
// the record the window list keeps. Pulled out of useEditorWindows so the open
// and the restore paths take one decision rather than two, and so the unit
// suite -- which has no renderer -- can judge it.
//
// The mode is decided from the path every time (FR-MDE-013). A restore record
// carries only the path, so an image reopens as an image and never through the
// text read (FR-MDE-018 AC-9).
//
// @req FR-MDE-007
// @req FR-MDE-016
// @req FR-MDE-018

import { resolveEditorMode } from '../editor/editorMode.ts';
import { isMissingFileError } from '../utils/editorFileMenu.ts';
import type { EditorTrayWindow } from '../components/editor/editorTrayModel.ts';
import type { DocumentEncoding } from '../components/editor/editorDocumentAccess.ts';
import type { EditorWindowSaveBinding } from '../components/editor/editorWindowSave.ts';

/**
 * An image tab's bytes, or the reason there are none. A failed image read is
 * shown inside the tab, so it is part of the document rather than an outcome
 * that keeps the tab from opening.
 * @req FR-MDE-018
 */
export type ImageDocumentState =
  | { status: 'ready'; blob: Blob; size: number }
  | { status: 'error'; error: unknown };

/** @req FR-MDE-018 */
export type LoadedDocument =
  | { kind: 'text'; bodyAtOpen: string; encoding: DocumentEncoding }
  | { kind: 'image'; image: ImageDocumentState };

/**
 * `missing` is the text-only 404: the FR-MDE-007 create prompt. An image never
 * answers it.
 * @req FR-MDE-007
 * @req FR-MDE-018
 */
export type DocumentLoadOutcome =
  | { status: 'loaded'; document: LoadedDocument }
  | { status: 'missing' }
  | { status: 'error'; error: unknown };

/** The shapes of `fileApi.readFile` and `fileApi.readImage`. */
export interface DocumentLoadDeps {
  readFile: (sessionId: string, path: string) => Promise<{ content: string; encoding?: string }>;
  readImage: (sessionId: string, path: string) => Promise<Blob>;
}

/**
 * One open document: a tab of its workspace's editor window. An image record
 * carries an empty body and `utf-8` so every reader of the text fields keeps
 * working; `kind` is what tells the two apart.
 * @req FR-MDE-007
 * @req FR-MDE-008
 * @req FR-MDE-018
 */
export type OpenDocumentRecord = EditorTrayWindow & {
  kind: 'text' | 'image';
  /** The content read from disk when the document opened. Never fed back. */
  bodyAtOpen: string;
  /** What the read reported. `unknown` opens the document read-only. @req FR-MDE-016 */
  encoding: DocumentEncoding;
  /** The image bytes or read failure; null for a text document. @req FR-MDE-018 */
  image: ImageDocumentState | null;
};

/**
 * Only an explicit `unknown` makes a document read-only, so a response without
 * the field behaves as it did before the field existed.
 * @req FR-MDE-016
 */
export function documentEncodingOf(file: { encoding?: string }): DocumentEncoding {
  return file.encoding === 'unknown' ? 'unknown' : 'utf-8';
}

/**
 * @req FR-MDE-007
 * @req FR-MDE-018
 */
export async function loadDocument(
  input: { filePath: string; sessionId: string },
  deps: DocumentLoadDeps,
): Promise<DocumentLoadOutcome> {
  const { filePath, sessionId } = input;

  if (resolveEditorMode(filePath).kind === 'image') {
    try {
      const blob = await deps.readImage(sessionId, filePath);
      return { status: 'loaded', document: { kind: 'image', image: { status: 'ready', blob, size: blob.size } } };
    } catch (error) {
      return { status: 'loaded', document: { kind: 'image', image: { status: 'error', error } } };
    }
  }

  try {
    const file = await deps.readFile(sessionId, filePath);
    return {
      status: 'loaded',
      document: { kind: 'text', bodyAtOpen: file.content, encoding: documentEncodingOf(file) },
    };
  } catch (error) {
    return isMissingFileError(error) ? { status: 'missing' } : { status: 'error', error };
  }
}

/**
 * A document opens on what it just read, so it starts clean.
 * @req FR-MDE-018
 */
export function planOpenDocument(input: {
  filePath: string;
  tabId: string;
  workspaceId: string;
  document: LoadedDocument;
}): OpenDocumentRecord {
  const { filePath, tabId, workspaceId, document } = input;
  if (document.kind === 'image') {
    return { filePath, tabId, workspaceId, dirty: false, kind: 'image', bodyAtOpen: '', encoding: 'utf-8', image: document.image };
  }
  return {
    filePath,
    tabId,
    workspaceId,
    dirty: false,
    kind: 'text',
    bodyAtOpen: document.bodyAtOpen,
    encoding: document.encoding,
    image: null,
  };
}

/**
 * An image tab is view-only: its binding is read-only, so it never turns dirty
 * and its save writes nothing.
 * @req FR-MDE-016
 * @req FR-MDE-018
 */
export function documentSaveBinding(
  record: Pick<OpenDocumentRecord, 'tabId' | 'filePath' | 'kind' | 'encoding'>,
): EditorWindowSaveBinding {
  return {
    tabId: record.tabId,
    filePath: record.filePath,
    readOnly: record.kind === 'image' || record.encoding === 'unknown',
  };
}
