/**
 * FR-MDE-030 AC-3: a tab read again (its file changed on disk) is remounted on the new content.
 * What the user was looking at -- markdown source or rendered, HTML source or rendered -- lives
 * in the panel, so it is remembered here by file and handed back to the remounted panel.
 *
 * @req FR-MDE-030
 */
export type EditorViewKey = 'raw' | 'html';

const views = new Map<string, unknown>();

export function rememberEditorView(filePath: string, key: EditorViewKey, value: unknown): void {
  views.set(`${key}\u0000${filePath}`, value);
}

export function recallEditorView(filePath: string, key: EditorViewKey): unknown {
  return views.get(`${key}\u0000${filePath}`);
}
