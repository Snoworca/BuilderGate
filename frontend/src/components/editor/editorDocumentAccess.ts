// Whether an open document may be written back, and the words the window uses
// to say so.
//
// The server reports `encoding: 'unknown'` for a text file whose bytes are not
// valid UTF-8. That text reached the browser through a lossy decode, so saving
// it would replace the original bytes with the decoder's substitutes -- the
// document opens read-only instead, and says why.
//
// @req FR-MDE-015
// @req FR-MDE-016

import { t } from '../../i18n/i18n.ts';
import type { LineEnding } from '../../editor/lineEndings.ts';

/** The encoding the read endpoint reported for the file. */
export type DocumentEncoding = 'utf-8' | 'unknown';

export interface DocumentAccess {
  readOnly: boolean;
  /** The line shown above the document, or null when there is nothing to say. */
  notice: string | null;
}


/**
 * A UTF-8 file behaves exactly as before; anything else is read-only. A file
 * the server read from another worktree of the session folder's repository is
 * read-only too: writes stay inside the session folder (SEC-FOP-002 AC-6).
 * @req FR-MDE-016
 * @req SEC-FOP-002
 */
export function decideDocumentAccess(encoding: DocumentEncoding, worktree?: string): DocumentAccess {
  if (encoding !== 'utf-8') {
    return { readOnly: true, notice: t('editor.access.notUtf8') };
  }
  if (worktree !== undefined) {
    return { readOnly: true, notice: t('editor.access.otherWorktree', { name: worktree }) };
  }
  return { readOnly: false, notice: null };
}

const LINE_ENDING_LABELS: Record<LineEnding, 'CRLF' | 'LF' | 'CR'> = {
  '\r\n': 'CRLF',
  '\n': 'LF',
  '\r': 'CR',
};

/**
 * The name the window shows for the document's line ending.
 * @req FR-MDE-015
 */
export function lineEndingLabel(eol: LineEnding): 'CRLF' | 'LF' | 'CR' {
  return LINE_ENDING_LABELS[eol];
}
