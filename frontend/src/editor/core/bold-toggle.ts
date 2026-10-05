// Ctrl+B / Cmd+B toggles bold (`FR-MDE-025`).
//
// The vendored editor registers no bold shortcut, so the key did nothing. This lives here
// rather than in the vendor tree, which is kept close to upstream.

import { EditorSelection, Prec, type EditorState, type Extension, type TransactionSpec } from '@codemirror/state';
import { keymap, type EditorView } from '@codemirror/view';

const MARK = '**';
const W = MARK.length;

/**
 * The transaction that toggles bold on every selection range:
 * - a selection whose text is `**x**`, or that sits between `**` and `**`, loses the marks;
 * - any other selection is wrapped and stays selected;
 * - an empty cursor between `**` and `**` removes that empty pair, otherwise inserts one
 *   with the cursor in the middle.
 */
export function toggleBoldTransaction(state: EditorState): TransactionSpec {
  return state.changeByRange((range) => {
    const { from, to } = range;
    const before = state.sliceDoc(Math.max(0, from - W), from);
    const after = state.sliceDoc(to, to + W);

    if (range.empty) {
      if (before === MARK && after === MARK) {
        return {
          changes: [{ from: from - W, to: from }, { from: to, to: to + W }],
          range: EditorSelection.cursor(from - W),
        };
      }
      return { changes: { from, insert: MARK + MARK }, range: EditorSelection.cursor(from + W) };
    }

    const text = state.sliceDoc(from, to);
    if (text.length >= 2 * W && text.startsWith(MARK) && text.endsWith(MARK)) {
      return {
        changes: [{ from, to: from + W }, { from: to - W, to }],
        range: EditorSelection.range(from, to - 2 * W),
      };
    }
    if (before === MARK && after === MARK) {
      return {
        changes: [{ from: from - W, to: from }, { from: to, to: to + W }],
        range: EditorSelection.range(from - W, to - W),
      };
    }
    return {
      changes: [{ from, insert: MARK }, { from: to, insert: MARK }],
      range: EditorSelection.range(from + W, to + W),
    };
  });
}

export function toggleBold(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  view.dispatch(view.state.update(toggleBoldTransaction(view.state), { userEvent: 'input.format', scrollIntoView: true }));
  return true;
}

/** High precedence so no default binding for Mod-b can take the key first. */
export function boldKeymap(): Extension {
  return Prec.high(keymap.of([{ key: 'Mod-b', run: toggleBold, preventDefault: true }]));
}
