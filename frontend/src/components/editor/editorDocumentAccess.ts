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

import type { LineEnding } from '../../editor/lineEndings.ts';

/** The encoding the read endpoint reported for the file. */
export type DocumentEncoding = 'utf-8' | 'unknown';

export interface DocumentAccess {
  readOnly: boolean;
  /** The line shown above the document, or null when there is nothing to say. */
  notice: string | null;
}

const NOT_UTF8_NOTICE = 'UTF-8 이 아니라서 읽기 전용으로 열었습니다. 저장하면 원래 바이트가 손상되므로 저장할 수 없습니다.';

/**
 * A UTF-8 file behaves exactly as before; anything else is read-only.
 * @req FR-MDE-016
 */
export function decideDocumentAccess(encoding: DocumentEncoding): DocumentAccess {
  if (encoding === 'utf-8') {
    return { readOnly: false, notice: null };
  }
  return { readOnly: true, notice: NOT_UTF8_NOTICE };
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
