// Which document the editor window's title bar close control is about.
//
// One press, one document. The control used to close the window itself, which
// meant discarding every document open in it -- and because the branch that
// did so was the one taken when nothing was dirty, it asked nothing first. A
// window carrying a dozen tabs was emptied by a single press with no prompt
// and nothing to undo it.
//
// The document is the active one rather than the first dirty one. A press is
// only answerable if it is about the file on screen; resolving it against some
// other tab means jumping the window to a document the user did not select and
// asking about a file they were not looking at.
// @req FR-MDE-011

/** One document, or none -- never a set. */
export type EditorWindowCloseControlPlan =
  | { kind: 'close-tab'; filePath: string }
  | { kind: 'nothing' };

export interface EditorWindowCloseControlInput {
  readonly tabs: readonly { readonly filePath: string }[];
  readonly activeFilePath: string | null;
}

/**
 * Resolves a press of the title bar close control.
 *
 * An active path that names no open tab falls back to the first tab rather
 * than to nothing: a control that silently does nothing is indistinguishable
 * from a broken one, and the state is reachable while a close is in flight.
 * @req FR-MDE-011
 */
export function planEditorWindowCloseControl(
  input: EditorWindowCloseControlInput,
): EditorWindowCloseControlPlan {
  const active = input.tabs.find(tab => tab.filePath === input.activeFilePath);
  const target = active ?? input.tabs[0];

  return target === undefined
    ? { kind: 'nothing' }
    : { kind: 'close-tab', filePath: target.filePath };
}
