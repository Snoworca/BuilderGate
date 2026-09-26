import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EditorState } from '@codemirror/state';
import type * as LineEndingsModule from '../../src/editor/lineEndings.ts';

// FR-MDE-015 AC-1..AC-5 -- saving keeps the line endings and BOM the file was
// opened with.
//
// CodeMirror 6 joins lines with "\n" in doc.toString(), so the editor used to
// turn every CRLF into LF on save. With EditorState.lineSeparator set to the
// file's dominant ending, state.sliceDoc() joins with that ending and leaves
// any other line-break characters inside the line text, byte for byte. These
// tests drive a real EditorState so that claim is checked here, not assumed.
//
// Contract fixed here for src/editor/lineEndings.ts:
//   analyzeText(raw) -> { eol: '\r\n' | '\n' | '\r', bom: boolean, body: string }
//       eol  -- the most frequent line ending in raw ('\n' when raw has none)
//       bom  -- raw starts with U+FEFF
//       body -- raw without the leading U+FEFF, line endings untouched
//   encodeForSave(editorText, { eol, bom }) -> string
//       editorText is state.sliceDoc() of an EditorState created with
//       EditorState.lineSeparator.of(eol); the result is what goes to disk.
//
// The module is loaded inside each test: a static import of a missing module
// kills the runner before any test is named. The `import type` line is erased
// at runtime and lets tsc check every call against the real signatures.
const LINE_ENDINGS_PATH = '../../src/editor/lineEndings.ts';
type LineEndings = typeof LineEndingsModule;

async function loadLineEndings(): Promise<LineEndings> {
  const m = await import(LINE_ENDINGS_PATH) as LineEndings;
  for (const name of ['analyzeText', 'encodeForSave']) {
    assert.equal(typeof (m as unknown as Record<string, unknown>)[name], 'function', `lineEndings exports ${name}`);
  }
  return m;
}

// Open raw the way the editor will: split off BOM, build a CM6 state that uses
// the detected ending as its line separator, optionally edit, then encode what
// sliceDoc() returns.
async function openEditSave(
  raw: string,
  edit?: (state: EditorState) => EditorState,
): Promise<{ saved: string; eol: string; bom: boolean; body: string }> {
  const { analyzeText, encodeForSave } = await loadLineEndings();
  const { eol, bom, body } = analyzeText(raw);
  let state = EditorState.create({ doc: body, extensions: [EditorState.lineSeparator.of(eol)] });
  if (edit) state = edit(state);
  return { saved: encodeForSave(state.sliceDoc(), { eol, bom }), eol, bom, body };
}

function differingIndexes(a: string, b: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) out.push(i);
  }
  return out;
}

test('CRLF 본문을 열고 한 글자 바꾼 뒤 encodeForSave 결과가 원본과 그 글자만 다르다', async () => {
  const raw = 'alpha\r\nbeta\r\ngamma\r\n';
  const at = raw.indexOf('beta');
  // CM6 counts a line break as one position whatever the separator, so the
  // edit is addressed by line, not by the raw byte offset.
  const { saved, eol } = await openEditSave(raw, (s) => {
    const from = s.doc.line(2).from;
    return s.update({ changes: { from, to: from + 1, insert: 'B' } }).state;
  });
  assert.equal(eol, '\r\n');
  assert.equal(saved.length, raw.length, `saved=${JSON.stringify(saved)}`);
  assert.deepEqual(differingIndexes(raw, saved), [at], `saved=${JSON.stringify(saved)}`);
  assert.equal(saved, 'alpha\r\nBeta\r\ngamma\r\n');
});

test('detectLineEnding: LF 만 → "\\n", CR 단독만 → "\\r"; 왕복 저장이 바이트 동일', async () => {
  // "detectLineEnding" is analyzeText(raw).eol; no separate export is required.
  const lf = 'one\ntwo\nthree\n';
  const lfRun = await openEditSave(lf);
  assert.equal(lfRun.eol, '\n');
  assert.equal(lfRun.saved, lf);

  const cr = 'one\rtwo\rthree\r';
  const crRun = await openEditSave(cr);
  assert.equal(crRun.eol, '\r');
  assert.equal(crRun.saved, cr);

  // An edit must not change the ending either.
  const crEdited = await openEditSave(cr, (s) => s.update({ changes: { from: 0, to: 1, insert: 'O' } }).state);
  assert.equal(crEdited.saved, 'One\rtwo\rthree\r');
});

test('섞인 줄바꿈: 최다 종류가 lineSeparator, 소수 종류 문자는 저장 결과에 바이트 그대로 남는다', async () => {
  // Three CRLF, one LF, one CR: CRLF wins, and the lone "\n" / "\r" are kept.
  const raw = 'a\r\nb\r\nc\nd\re\r\n';
  const untouched = await openEditSave(raw);
  assert.equal(untouched.eol, '\r\n');
  assert.equal(untouched.saved, raw);

  const edited = await openEditSave(raw, (s) => s.update({ changes: { from: 0, to: 1, insert: 'A' } }).state);
  assert.deepEqual(differingIndexes(raw, edited.saved), [0], `saved=${JSON.stringify(edited.saved)}`);

  // Majority LF with one CRLF: the CRLF is not rewritten to LF.
  const lfMajor = 'x\ny\nz\r\nw\n';
  const lfRun = await openEditSave(lfMajor);
  assert.equal(lfRun.eol, '\n');
  assert.equal(lfRun.saved, lfMajor);
});

test('BOM 있던 본문은 BOM 을 떼고 편집기에 넣고 저장 시 다시 붙인다; 없던 본문은 붙이지 않는다', async () => {
  const withBom = '\uFEFF# Title\r\nbody\r\n';
  const bomRun = await openEditSave(withBom);
  assert.equal(bomRun.bom, true);
  assert.equal(bomRun.body.startsWith('\uFEFF'), false, 'the editor must not receive the BOM');
  assert.equal(bomRun.body, '# Title\r\nbody\r\n');
  assert.equal(bomRun.saved, withBom);

  const noBom = '# Title\nbody\n';
  const plainRun = await openEditSave(noBom);
  assert.equal(plainRun.bom, false);
  assert.equal(plainRun.saved, noBom);
  assert.equal(plainRun.saved.charCodeAt(0) === 0xfeff, false);
});

test('빈 본문은 eol="\\n", bom=false 로 판정된다', async () => {
  const { analyzeText, encodeForSave } = await loadLineEndings();
  assert.deepEqual(analyzeText(''), { eol: '\n', bom: false, body: '' });

  // Typing into a new empty file saves LF and no BOM.
  const run = await openEditSave('', (s) => s.update({ changes: { from: 0, insert: 'a' } }).state);
  assert.equal(run.saved, 'a');
  const twoLines = EditorState.create({ doc: 'a', extensions: [EditorState.lineSeparator.of('\n')] })
    .update({ changes: { from: 1, insert: '\nb' } }).state;
  assert.equal(encodeForSave(twoLines.sliceDoc(), { eol: '\n', bom: false }), 'a\nb');
});

// Strip // and /* */ comments so prose about the old wiring neither trips nor
// satisfies the guard. String literals are not special-cased: the patterns
// below are JSX/expression shapes, not text a string would plausibly carry.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('소스 가드: EditorDocumentPanel.tsx 에 onMarkdownChange={controller.handleEditorChange} 가 없고 저장 본문은 sliceDoc 리스너만 공급한다', () => {
  const url = new URL('../../src/components/editor/EditorDocumentPanel.tsx', import.meta.url);
  const code = stripComments(readFileSync(url, 'utf8'));

  // The old path fed doc.toString() (always "\n") to the save controller.
  assert.equal(
    /onMarkdownChange\s*=\s*\{\s*controller\.handleEditorChange\s*\}/.test(code),
    false,
    'EditorDocumentPanel must not wire onMarkdownChange to controller.handleEditorChange',
  );
  // The replacement: an updateListener that reads state.sliceDoc(), with the
  // editor told the file's ending, and the saved text encoded for disk.
  assert.match(code, /EditorView\.updateListener/, 'an EditorView.updateListener supplies the save body');
  assert.match(code, /\.sliceDoc\(\s*\)/, 'the save body comes from state.sliceDoc()');
  assert.match(code, /EditorState\.lineSeparator\.of\(/, 'the editor state uses the file line ending');
  assert.match(code, /\bencodeForSave\(/, 'the save path encodes through encodeForSave');
  assert.match(code, /\banalyzeText\(/, 'the opened body is split through analyzeText');
});

// FR-MDE-015 AC-1/AC-3 -- with lineSeparator set, CodeMirror splits inserted
// text on that exact separator only, so a plain "\n" typed or pasted into a
// CRLF file stayed inside one editor line and was saved as a stray LF.
// normalizeInsertedLineBreaks(eol) rewrites only the inserted text; bytes that
// were already in the file (minority endings, AC-3) are left untouched.
async function loadNormalizer(): Promise<LineEndings['normalizeInsertedLineBreaks']> {
  const m = await loadLineEndings();
  const fn = (m as unknown as Record<string, unknown>).normalizeInsertedLineBreaks;
  assert.equal(typeof fn, 'function', 'lineEndings exports normalizeInsertedLineBreaks');
  return m.normalizeInsertedLineBreaks;
}

test('CRLF 문서에 LF 가 든 텍스트를 삽입하면 새 줄로 나뉘고 CRLF 로 저장된다', async () => {
  const normalize = await loadNormalizer();
  const state = EditorState.create({
    doc: 'a\r\nb',
    extensions: [EditorState.lineSeparator.of('\r\n'), normalize('\r\n')],
  });
  const next = state.update({ changes: { from: 1, insert: '\n- x\ny' } }).state;
  assert.equal(next.doc.lines, 4, 'each inserted LF starts a new editor line');
  assert.equal(next.sliceDoc(), 'a\r\n- x\r\ny\r\nb');
});

test('LF 문서에 CRLF·CR 이 든 텍스트를 삽입하면 LF 로 바뀐다', async () => {
  const normalize = await loadNormalizer();
  const state = EditorState.create({
    doc: 'a\nb',
    extensions: [EditorState.lineSeparator.of('\n'), normalize('\n')],
  });
  const next = state.update({ changes: { from: 1, insert: 'p\r\nq\rr' } }).state;
  assert.equal(next.doc.lines, 4);
  assert.equal(next.sliceDoc(), 'ap\nq\nr\nb');
});

test('삽입 정규화는 파일에 원래 있던 소수 줄바꿈을 건드리지 않는다 (AC-3)', async () => {
  const normalize = await loadNormalizer();
  const state = EditorState.create({
    doc: 'a\r\nb\nc\r\nd',
    extensions: [EditorState.lineSeparator.of('\r\n'), normalize('\r\n')],
  });
  const next = state.update({ changes: { from: state.doc.length, insert: 'X' } }).state;
  assert.equal(next.sliceDoc(), 'a\r\nb\nc\r\ndX');
});

test('소스 가드: 편집 패널과 SVG 소스 탭이 lineSeparator 옆에 삽입 정규화를 건다', () => {
  for (const rel of ['../../src/components/editor/EditorDocumentPanel.tsx', '../../src/components/editor/SvgFileTab.tsx']) {
    const code = readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.match(code, /normalizeInsertedLineBreaks\(/, `${rel} normalizes inserted line breaks`);
  }
});
