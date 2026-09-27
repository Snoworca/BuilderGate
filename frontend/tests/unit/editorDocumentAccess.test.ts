import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as DocumentAccessModule from '../../src/components/editor/editorDocumentAccess.ts';

// FR-MDE-016 AC-1 / AC-3 / AC-4 -- a text file that is not UTF-8 opens read-only
// with a notice; a UTF-8 file behaves as before.
// FR-MDE-015 AC-6 -- the editor shows which line ending the document uses.
//
// Contract fixed here for src/components/editor/editorDocumentAccess.ts:
//   decideDocumentAccess(encoding: 'utf-8' | 'unknown')
//       -> { readOnly: boolean, notice: string | null }
//   lineEndingLabel(eol: '\r\n' | '\n' | '\r') -> 'CRLF' | 'LF' | 'CR'
//
// The module is loaded inside each test: a static import of a missing module
// kills the runner before any test is named. The `import type` line is erased
// at runtime and lets tsc check every call against the real signatures.
const DOCUMENT_ACCESS_PATH = '../../src/components/editor/editorDocumentAccess.ts';
type DocumentAccess = typeof DocumentAccessModule;

async function loadDocumentAccess(): Promise<DocumentAccess> {
  const m = await import(DOCUMENT_ACCESS_PATH) as DocumentAccess;
  for (const name of ['decideDocumentAccess', 'lineEndingLabel']) {
    assert.equal(
      typeof (m as unknown as Record<string, unknown>)[name],
      'function',
      `editorDocumentAccess exports ${name}`,
    );
  }
  return m;
}

test('lineEndingLabel: "\\r\\n"→CRLF, "\\n"→LF, "\\r"→CR', async () => {
  const { lineEndingLabel } = await loadDocumentAccess();
  assert.equal(lineEndingLabel('\r\n'), 'CRLF');
  assert.equal(lineEndingLabel('\n'), 'LF');
  assert.equal(lineEndingLabel('\r'), 'CR');
});

test('decideDocumentAccess("unknown") → readOnly=true', async () => {
  const { decideDocumentAccess } = await loadDocumentAccess();
  assert.equal(decideDocumentAccess('unknown').readOnly, true);
});

test('decideDocumentAccess("unknown").notice 가 "UTF-8 이 아니라서 읽기 전용" 문구를 담는다', async () => {
  const { decideDocumentAccess } = await loadDocumentAccess();
  const { notice } = decideDocumentAccess('unknown');
  assert.equal(typeof notice, 'string', `notice=${JSON.stringify(notice)}`);
  // The two facts the user needs: why (not UTF-8) and what it means (read-only).
  assert.match(notice as string, /UTF-8/, `notice=${JSON.stringify(notice)}`);
  assert.match(notice as string, /읽기 전용/, `notice=${JSON.stringify(notice)}`);
});

test('decideDocumentAccess("utf-8") → readOnly=false, notice=null', async () => {
  const { decideDocumentAccess } = await loadDocumentAccess();
  assert.deepEqual(decideDocumentAccess('utf-8'), { readOnly: false, notice: null });
});
