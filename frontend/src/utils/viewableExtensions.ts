import { resolveEditorMode } from '../editor/editorMode.ts';

// Kept only for the unmounted MdirPanel. The editor-mode table (FR-MDE-013) is
// the single source of which files open; this holds no extension set of its own.
export function isViewableExtension(filePath: string): boolean {
  return resolveEditorMode(filePath).kind !== 'none';
}
