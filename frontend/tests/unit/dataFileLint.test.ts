import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createEditorWindowSaveController } from '../../src/components/editor/editorWindowSave.ts';
import type * as DataFileLintModule from '../../src/components/editor/dataFileLint.ts';
import type * as CsvColumnsModule from '../../src/components/editor/csvColumns.ts';

// FR-MDE-017 -- data-file diagnostics and CSV/TSV column colouring, without a DOM.
//
// Contract fixed here:
//   src/components/editor/dataFileLint.ts
//     lintJson(text)  -> Array<{ line: number; message: string }>   (1-based line)
//       built on @codemirror/lang-json's jsonParseLinter (AC-1)
//     lintJsonl(text) -> same shape; JSON.parse per non-blank line (AC-2)
//     lintYaml(text)  -> same shape; error nodes of the lang-yaml syntax tree (AC-3)
//     The CM6 linter adapter wraps these pure functions thinly (T-PH004-02).
//   src/components/editor/csvColumns.ts
//     splitDelimitedColumns(line, delimiter: ',' | '\t')
//       -> Array<{ from: number; to: number }>   column cells, delimiters excluded,
//          a delimiter inside double quotes (with "" escapes) does not split (AC-4)
//     CSV_COLUMN_COLOR_COUNT: number              size of the colour cycle
//     csvColumnClass(index) -> string             cycles every CSV_COLUMN_COLOR_COUNT
//
// Modules are loaded inside each test: a static import of a missing module
// kills the runner before any test is named. `import type` is erased at runtime.
const LINT_PATH = '../../src/components/editor/dataFileLint.ts';
const CSV_PATH = '../../src/components/editor/csvColumns.ts';

async function loadLint(): Promise<typeof DataFileLintModule> {
  return await import(LINT_PATH) as typeof DataFileLintModule;
}

async function loadCsv(): Promise<typeof CsvColumnsModule> {
  return await import(CSV_PATH) as typeof CsvColumnsModule;
}

function cells(line: string, spans: ReadonlyArray<{ from: number; to: number }>): string[] {
  return spans.map((s) => line.slice(s.from, s.to));
}

test('json 린터: 잘못된 JSON 은 오류 위치 줄에 진단 1건, 고친 본문은 0건 (jsonParseLinter 사용)', async () => {
  // TC-REQ-FR-MDE-017-AC1-01
  const { lintJson } = await loadLint();
  const broken = '{\n  "a": 1\n  "b": 2\n}';
  const diagnostics = lintJson(broken);
  assert.equal(diagnostics.length, 1, 'one diagnostic for one parse error');
  assert.equal(diagnostics[0].line, 3, 'the missing comma is reported on line 3, where "b" starts');
  assert.ok(diagnostics[0].message.length > 0, 'the diagnostic carries a message');

  assert.deepEqual(lintJson('{\n  "a": 1,\n  "b": 2\n}'), [], 'the fixed body has no diagnostics');

  const source = readFileSync(new URL(LINT_PATH, import.meta.url), 'utf8');
  assert.match(source, /jsonParseLinter/, 'JSON checking goes through @codemirror/lang-json jsonParseLinter');
});

test('json 린터: 위치를 말하지 않는 V8 오류(Unexpected token)도 오류 줄에 진단한다 — 1행으로 떨어지지 않는다', async () => {
  // TC-REQ-FR-MDE-017-AC1-01 (regression, found by the E2E run of T-PH008-01)
  // V8 reports "Unexpected token ','" with no "at position N", and
  // jsonParseLinter then falls back to position 0: the marker was drawn on
  // line 1 while the broken value sat on line 3.
  const { lintJson } = await loadLint();
  const cases: Array<{ text: string; line: number }> = [
    { text: '{\n  "a": 1,\n  "b": ,\n  "c": 3\n}\n', line: 3 },
    { text: '{\n "a": [1, 2,,]\n}', line: 2 },
    { text: '{\n\n "a": tru\n}', line: 3 },
  ];
  for (const { text, line } of cases) {
    let v8Message = '';
    try { JSON.parse(text); } catch (error) { v8Message = (error as Error).message; }
    assert.doesNotMatch(v8Message, /at position \d+|at line \d+ column \d+/,
      `precondition: V8 gives no position for ${JSON.stringify(text)}`);
    const diagnostics = lintJson(text);
    assert.equal(diagnostics.length, 1, `one diagnostic for ${JSON.stringify(text)}`);
    assert.equal(diagnostics[0].line, line, `reported on line ${line} for ${JSON.stringify(text)}`);
  }
});

test('jsonl 린터: 줄마다 JSON.parse, 3줄 중 2번째만 깨지면 2번째 줄 진단 1건; 전체를 한 JSON 으로 검사하지 않는다', async () => {
  // TC-REQ-FR-MDE-017-AC2-01
  const { lintJsonl } = await loadLint();
  const text = '{"id":1}\n{"id":2,}\n{"id":3}\n';
  const diagnostics = lintJsonl(text);
  assert.equal(diagnostics.length, 1, 'only the broken record is reported');
  assert.equal(diagnostics[0].line, 2);

  // Three valid records are not one valid JSON document: a whole-body check
  // would report this, a per-line check must not. Blank lines are skipped.
  assert.deepEqual(lintJsonl('{"id":1}\n\n{"id":2}\n{"id":3}'), [], 'valid records on separate lines pass');
});

test('yaml 린터: lang-yaml 구문 트리 오류 노드를 해당 줄 진단으로 낸다', async () => {
  // TC-REQ-FR-MDE-017-AC3-01
  const { lintYaml } = await loadLint();
  const diagnostics = lintYaml('a: 1\n  b: 2\n');
  assert.equal(diagnostics.length, 1, 'the misplaced indentation yields one diagnostic');
  assert.equal(diagnostics[0].line, 2, 'the diagnostic lands on line 2, where the error node is');

  assert.deepEqual(lintYaml('a: 1\nb:\n  - x\n'), [], 'a valid document has no diagnostics');
});

test('splitDelimitedColumns: CSV 쉼표·TSV 탭, 큰따옴표 안 구분자·"" 이스케이프는 열을 나누지 않는다; 열 index 순환 색 클래스', async () => {
  // TC-REQ-FR-MDE-017-AC4-01
  const { splitDelimitedColumns, csvColumnClass, CSV_COLUMN_COLOR_COUNT } = await loadCsv();

  const csv = 'a,b,c';
  assert.deepEqual(cells(csv, splitDelimitedColumns(csv, ',')), ['a', 'b', 'c']);

  const quoted = 'x,"hello, world","say ""hi"", ok",z';
  assert.deepEqual(
    cells(quoted, splitDelimitedColumns(quoted, ',')),
    ['x', '"hello, world"', '"say ""hi"", ok"', 'z'],
    'commas inside quotes, including after an "" escape, stay in their cell',
  );

  const tsv = 'a\tb,c\td';
  assert.deepEqual(cells(tsv, splitDelimitedColumns(tsv, '\t')), ['a', 'b,c', 'd'], 'TSV splits on tabs only');

  assert.deepEqual(cells('a,,b', splitDelimitedColumns('a,,b', ',')), ['a', '', 'b'], 'an empty cell is still a column');

  assert.ok(Number.isInteger(CSV_COLUMN_COLOR_COUNT) && CSV_COLUMN_COLOR_COUNT >= 2, 'at least two colours cycle');
  assert.notEqual(csvColumnClass(0), csvColumnClass(1), 'neighbouring columns differ');
  assert.equal(csvColumnClass(0), csvColumnClass(CSV_COLUMN_COLOR_COUNT), 'the class cycles');
});

test('진단이 있어도 저장 컨트롤러 save() 가 writeFile 을 보낸다', async () => {
  // TC-REQ-FR-MDE-017-AC5-01
  const { lintJson } = await loadLint();
  const broken = '{\n  "a": 1\n  "b": 2\n}';
  assert.ok(lintJson(broken).length > 0, 'precondition: the body being saved has a diagnostic');

  const writes: string[] = [];
  const controller = createEditorWindowSaveController({
    binding: { tabId: 'tab-1', filePath: '/work/data/config.json' },
    bodyAtOpen: '{}\n',
    deps: {
      resolveTabSession: () => 'session-1',
      writeFile: async (_sessionId, _path, content) => {
        writes.push(content);
        return { success: true };
      },
    },
  });
  controller.handleEditorChange(broken);
  const outcome = await controller.save();
  assert.deepEqual(outcome, { status: 'saved' }, 'a syntax error does not block saving');
  assert.deepEqual(writes, [broken], 'the body is written as is');
});

test('frontend/package.json dependencies 에 @codemirror/lint 가 있다', () => {
  // TC-REQ-FR-MDE-017-AC6-01
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  assert.ok(pkg.dependencies?.['@codemirror/lint'], '@codemirror/lint is a direct dependency');
});
