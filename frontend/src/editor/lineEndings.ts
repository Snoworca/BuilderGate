// Keeps the line endings and the BOM a file was opened with when it is saved.
//
// CodeMirror 6 joins lines with "\n" in doc.toString(), so writing that string
// back turned every CRLF into LF. The editor is instead told the file's
// dominant ending through EditorState.lineSeparator; the document is then split
// on that ending only, any other line-break character stays inside the line
// text, and state.sliceDoc() joins with that same ending -- byte for byte what
// was read, plus the user's edits.
//
// @req FR-MDE-015

import { EditorState, Transaction, type ChangeSpec, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/** The three line endings a text file can use. */
export type LineEnding = '\r\n' | '\n' | '\r';

export interface TextLayout {
  /** The most frequent line ending in the file; "\n" when there is none. */
  eol: LineEnding;
  /** The file starts with U+FEFF. */
  bom: boolean;
  /** The file without its leading U+FEFF, line endings untouched. */
  body: string;
}

const BOM = '﻿';

/**
 * Splits a file as read from disk into what the editor shows and what saving
 * has to put back. Ties between endings go to CRLF, then LF, then CR.
 * @req FR-MDE-015
 */
export function analyzeText(raw: string): TextLayout {
  const bom = raw.startsWith(BOM);
  const body = bom ? raw.slice(BOM.length) : raw;

  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    if (c === 13) {
      if (body.charCodeAt(i + 1) === 10) {
        crlf += 1;
        i += 1;
      } else {
        cr += 1;
      }
    } else if (c === 10) {
      lf += 1;
    }
  }

  let eol: LineEnding = '\n';
  if (crlf > 0 && crlf >= lf && crlf >= cr) {
    eol = '\r\n';
  } else if (cr > lf) {
    eol = '\r';
  }

  return { eol, bom, body };
}

/**
 * The bytes to write for `editorText`, which must be state.sliceDoc() of a
 * state created with EditorState.lineSeparator.of(layout.eol) -- that call has
 * already joined the lines with the file's ending, so only the BOM is left to
 * restore. `eol` is part of the input so a caller passes the same layout it
 * configured the editor with.
 * @req FR-MDE-015
 */
export function encodeForSave(editorText: string, layout: { eol: LineEnding; bom: boolean }): string {
  return layout.bom ? BOM + editorText : editorText;
}

const ANY_LINE_BREAK = /\r\n|\r|\n/g;

/**
 * Makes line breaks the user types or pastes into the file's own ending.
 *
 * With EditorState.lineSeparator set, CodeMirror splits inserted text on that
 * exact separator only, so a plain "\n" inserted into a CRLF file (Enter in a
 * list, a code-fence auto-close, the table widget, a paste from another OS)
 * stayed inside one editor line and was saved as a stray LF. This rewrites the
 * inserted text of every change; what was already in the file -- including
 * minority endings kept as bytes -- is never touched.
 * @req FR-MDE-015
 */
export function normalizeInsertedLineBreaks(eol: LineEnding): Extension {
  return [
    EditorState.transactionFilter.of((tr) => {
      if (!tr.docChanged) return tr;
      const changes: ChangeSpec[] = [];
      let rewritten = false;
      let sameLength = true;
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        const text = inserted.sliceString(0, inserted.length, eol);
        const normalized = text.replace(ANY_LINE_BREAK, eol);
        if (normalized !== text) rewritten = true;
        changes.push({ from: fromA, to: toA, insert: normalized });
      });
      if (!rewritten) return tr;
      const next = tr.startState.changes(changes);
      if (next.newLength !== tr.changes.newLength) sameLength = false;
      const userEvent = tr.annotation(Transaction.userEvent);
      return {
        changes: next,
        selection: sameLength ? tr.selection : tr.startState.selection.map(next, 1),
        effects: tr.effects,
        scrollIntoView: tr.scrollIntoView,
        ...(userEvent === undefined ? {} : { userEvent }),
      };
    }),
    EditorView.clipboardInputFilter.of((text) => text.replace(ANY_LINE_BREAK, eol)),
  ];
}
