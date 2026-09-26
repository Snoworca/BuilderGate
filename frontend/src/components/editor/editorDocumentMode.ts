// FR-MDE-014 -- which component draws a document, from its editor mode.
// Pure and framework-free, so the document panel and unit tests read the same
// answer. The branch lives here and in the panel, never in the vendored
// markdown editor (AC-8).
//
// @req FR-MDE-014

import type { EditorModeKind } from '../../editor/editorMode.ts';

/** The component a document panel draws. */
export type DocumentComponent = 'markdown' | 'code' | 'image';

/**
 * markdown -> the vendored AtomicCodeMirrorEditor, code -> CodeFileEditor,
 * image -> the image viewer's slot (FR-MDE-018). `none` is not an editor
 * document, so it answers null.
 * @req FR-MDE-014
 */
export function selectDocumentComponent(kind: EditorModeKind): DocumentComponent | null {
  switch (kind) {
    case 'markdown':
      return 'markdown';
    case 'code':
      return 'code';
    case 'image':
      return 'image';
    default:
      return null;
  }
}

/**
 * What the panel draws once the markdown raw-view toggle is taken into
 * account: a markdown document shown raw uses the code editor (FR-MDE-023).
 * @req FR-MDE-023
 */
export function effectiveDocumentComponent<T extends string | null>(component: T, raw: boolean): T | 'code' {
  return component === 'markdown' && raw ? 'code' : component;
}
