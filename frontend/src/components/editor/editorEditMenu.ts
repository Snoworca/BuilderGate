// The editor body's context menu: 모두 선택 · 복사 · 잘라내기 · 붙여넣기
// (FR-MDE-022). It replaces the browser's own menu on the document, on right
// click and on a long press.
//
// The commands act on the CodeMirror view reached from the editor's content
// DOM, so the vendored editor needs no new handle method. A paste is dispatched
// as an ordinary transaction, which is what the line-ending filter
// (FR-MDE-015) rewrites.
// @req FR-MDE-022
import { t } from '../../i18n/i18n.ts';
import { EditorView } from '@codemirror/view';
import type { EditorState, TransactionSpec } from '@codemirror/state';
import type { ContextMenuItem } from '../ContextMenu/index.ts';

export type EditorEditCommand = 'selectAll' | 'copy' | 'cut' | 'paste';

export interface EditorEditMenuOptions {
  hasSelection: boolean;
  readOnly: boolean;
  onSelectAll: () => void;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
}

export function buildEditorEditMenuItems(options: EditorEditMenuOptions): ContextMenuItem[] {
  return [
    { label: t('editor.menu.selectAll'), shortcut: 'Ctrl+A', onClick: options.onSelectAll },
    { separator: true },
    { label: t('common.copy'), shortcut: 'Ctrl+C', onClick: options.onCopy, disabled: !options.hasSelection },
    { label: t('editor.menu.cut'), shortcut: 'Ctrl+X', onClick: options.onCut, disabled: !options.hasSelection || options.readOnly },
    { label: t('common.paste'), shortcut: 'Ctrl+V', onClick: options.onPaste, disabled: options.readOnly },
  ];
}

/** What the commands need of a view -- a real EditorView, or a stand-in in tests. */
export interface EditorEditTarget {
  readonly state: EditorState;
  dispatch: (spec: TransactionSpec) => void;
  focus: () => void;
}

export interface EditorEditClipboard {
  readText: () => Promise<string>;
  writeText: (text: string) => Promise<void>;
}

/** The view behind an editor's content DOM, or null before it mounts. */
export function editorViewFromContent(content: HTMLElement | null): EditorView | null {
  return content === null ? null : EditorView.findFromDOM(content);
}

function selectedText(state: EditorState): string {
  return state.selection.ranges
    .filter(range => !range.empty)
    .map(range => state.sliceDoc(range.from, range.to))
    .join(state.lineBreak);
}

export function hasEditorSelection(state: EditorState): boolean {
  return state.selection.ranges.some(range => !range.empty);
}

/**
 * Runs one menu command. A clipboard failure (permission denied, no secure
 * context) leaves the document as it was and only warns: a cut whose copy
 * failed deletes nothing.
 */
export async function runEditorEditCommand(
  view: EditorEditTarget,
  command: EditorEditCommand,
  clipboard: EditorEditClipboard,
): Promise<void> {
  const { state } = view;
  try {
    switch (command) {
      case 'selectAll':
        view.dispatch({ selection: { anchor: 0, head: state.doc.length } });
        break;
      case 'copy': {
        const text = selectedText(state);
        if (text !== '') await clipboard.writeText(text);
        break;
      }
      case 'cut': {
        if (state.readOnly) break;
        const text = selectedText(state);
        if (text === '') break;
        await clipboard.writeText(text);
        view.dispatch({ ...view.state.replaceSelection(''), userEvent: 'delete.cut' });
        break;
      }
      case 'paste': {
        if (state.readOnly) break;
        const text = await clipboard.readText();
        if (text === '') break;
        view.dispatch({ ...view.state.replaceSelection(text), userEvent: 'input.paste', scrollIntoView: true });
        break;
      }
    }
  } catch (error) {
    console.warn(`[editor] ${command} could not use the clipboard`, error);
  }
  view.focus();
}
