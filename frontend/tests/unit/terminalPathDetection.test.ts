import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as TerminalPathDetectionModule from '../../src/utils/terminalPathDetection.ts';

// FR-ARCH-012 AC-1~AC-5 / FR-ARCH-013 AC-1·AC-3 — finding file paths in terminal
// rows, picking the one nearest a press, and listing the paths on screen.
//
// Loaded inside each test so a missing module fails each test by name instead of
// crashing the runner; the `import type` lets tsc check the calls.
const MODULE_PATH = '../../src/utils/terminalPathDetection.ts';
type M = typeof TerminalPathDetectionModule;

async function load(): Promise<M> {
  return await import(MODULE_PATH) as M;
}

/** One unwrapped row whose cells are one column per character. */
function row(text: string, isWrapped = false) {
  return { text, colOf: [...text].map((_, i) => i), isWrapped };
}

async function pathsOf(text: string): Promise<string[]> {
  const { findPathsInRows } = await load();
  return findPathsInRows([row(text)], 200).map((found) => found.path);
}

test('FR-ARCH-012 AC-1: relative, absolute and bare file names with an openable extension', async () => {
  assert.deepEqual(await pathsOf('created docs/design/main.html and ./icon.svg'), ['docs/design/main.html', './icon.svg']);
  assert.deepEqual(await pathsOf('see ../notes/plan.md'), ['../notes/plan.md']);
  assert.deepEqual(await pathsOf('C:\\work\\site\\index.html'), ['C:\\work\\site\\index.html']);
  assert.deepEqual(await pathsOf('/home/u/README.md'), ['/home/u/README.md']);
  assert.deepEqual(await pathsOf('edit main.html now'), ['main.html']);
});

test('FR-ARCH-012 AC-1: files the explorer cannot open are not paths', async () => {
  assert.deepEqual(await pathsOf('backup.bak archive.zip doc.pdf main.html.bak'), []);
  assert.deepEqual(await pathsOf('version 0.10.15 on example.com'), []);
});

test('FR-ARCH-012 AC-1: start and end columns of the path in its row', async () => {
  const { findPathsInRows } = await load();
  const [found] = findPathsInRows([row('ok: src/App.tsx done')], 200);
  assert.deepEqual(
    { start: [found.startRow, found.startCol], end: [found.endRow, found.endCol] },
    { start: [0, 4], end: [0, 14] },
  );
});

test('FR-ARCH-012 AC-2: a trailing line number is dropped from the path', async () => {
  assert.deepEqual(await pathsOf('src/App.tsx:42 and src/main.tsx:7:13'), ['src/App.tsx', 'src/main.tsx']);
});

test('FR-ARCH-012 AC-3: quotes, backticks, brackets and trailing punctuation are not part of the path', async () => {
  assert.deepEqual(
    await pathsOf('"a.html" `b.md` (c.svg) [d.ts], e.json. f.css: g.txt;'),
    ['a.html', 'b.md', 'c.svg', 'd.ts', 'e.json', 'f.css', 'g.txt'],
  );
});

test('FR-ARCH-012 AC-3: a Korean particle right after the path is not part of it', async () => {
  assert.deepEqual(await pathsOf('docs/a.html을 만들었습니다'), ['docs/a.html']);
});

test('FR-ARCH-012 AC-4: URLs and their parts are not paths', async () => {
  assert.deepEqual(await pathsOf('open https://example.com/docs/a.html or http://localhost:5173/index.html'), []);
  assert.deepEqual(await pathsOf('file:///C:/w/a.html'), []);
});

test('FR-ARCH-012 AC-5: a path wrapped onto the next row is one path', async () => {
  const { findPathsInRows } = await load();
  // 10 columns: "see docs/d" wraps into "esign.html".
  const rows = [row('see docs/d'), row('esign.html', true)];
  const [found] = findPathsInRows(rows, 10);
  assert.equal(found.path, 'docs/design.html');
  assert.deepEqual(
    { start: [found.startRow, found.startCol], end: [found.endRow, found.endCol] },
    { start: [0, 4], end: [1, 9] },
  );
});

test('FR-ARCH-012 AC-1: columns follow cells, so wide characters before a path keep it aligned', async () => {
  const { findPathsInRows } = await load();
  // "파일 a.md": each Hangul syllable takes two cells.
  const [found] = findPathsInRows([{ text: '파일 a.md', colOf: [0, 2, 4, 5, 6, 7, 8], isWrapped: false }], 20);
  assert.equal(found.path, 'a.md');
  assert.deepEqual([found.startCol, found.endCol], [5, 8]);
});

test('FR-ARCH-012 AC-1: readRow builds text and cell columns from xterm-like cells', async () => {
  const { readRow } = await load();
  const cells = [
    { chars: '파', width: 2 }, { chars: '', width: 0 },
    { chars: ' ', width: 1 },
    { chars: 'a', width: 1 }, { chars: '.', width: 1 }, { chars: 'm', width: 1 }, { chars: 'd', width: 1 },
  ];
  const line = {
    isWrapped: false,
    length: cells.length,
    getCell: (x: number) => {
      const cell = cells[x];
      return cell && { getChars: () => cell.chars, getWidth: () => cell.width };
    },
  };
  assert.deepEqual(readRow(line, cells.length), { text: '파 a.md', colOf: [0, 2, 3, 4, 5, 6], isWrapped: false });
});

test('FR-ARCH-013 AC-1: the path under the press wins, then the nearest column, then the rows around it', async () => {
  const { findPathsInRows, pickPathNear } = await load();
  const paths = findPathsInRows([row('top.md'), row('a.md          b.md'), row('bottom.md')], 40);
  assert.equal(pickPathNear(paths, 1, 15)?.path, 'b.md');
  assert.equal(pickPathNear(paths, 1, 6)?.path, 'a.md');
  const sparse = findPathsInRows([row('above.md'), row('nothing here'), row('')], 40);
  assert.equal(pickPathNear(sparse, 1, 3)?.path, 'above.md');
  assert.equal(pickPathNear(sparse, 2, 3), null);
});

test('FR-ARCH-013 AC-3: screen paths are listed bottom first, without duplicates, at most ten', async () => {
  const { findPathsInRows, listScreenPaths } = await load();
  const rows = [row('a.md b.md'), row('c.md a.md')];
  assert.deepEqual(listScreenPaths(findPathsInRows(rows, 40)).map(target => target.path), ['a.md', 'c.md', 'b.md']);
  const many = Array.from({ length: 12 }, (_, i) => row(`f${i}.md`));
  const listed = listScreenPaths(findPathsInRows(many, 40));
  assert.equal(listed.length, 10);
  assert.equal(listed[0].path, 'f11.md');
});

test('FR-ARCH-013 AC-1: the menu label uses the file name', async () => {
  const { fileNameOf } = await load();
  assert.equal(fileNameOf('docs/design/main.html'), 'main.html');
  assert.equal(fileNameOf('C:\\w\\a.svg'), 'a.svg');
});

test('FR-ARCH-013 AC-1: a point on the terminal screen maps to its cell; outside it maps to nothing', async () => {
  const { cellAtPoint } = await load();
  const rect = { left: 100, top: 50, width: 800, height: 400 }; // 80 cols x 20 rows: 10 x 20 px cells
  assert.deepEqual(cellAtPoint(rect, 80, 20, 100, 50), { row: 0, col: 0 });
  assert.deepEqual(cellAtPoint(rect, 80, 20, 255, 95), { row: 2, col: 15 });
  assert.deepEqual(cellAtPoint(rect, 80, 20, 899, 449), { row: 19, col: 79 });
  assert.equal(cellAtPoint(rect, 80, 20, 99, 60), null);
  assert.equal(cellAtPoint(rect, 80, 20, 300, 450), null);
});

test('FR-ARCH-012 AC-5: a TUI that indents each wrapped row (Claude Code) does not break the path; the fragments stay as fallbacks', async () => {
  const { findPathsInRows } = await load();
  // 43 columns, as on a phone: Claude Code cuts the path every 41 cells and puts
  // two spaces of indent before each piece, relying on the terminal to wrap.
  const rows = [
    row(String.raw`  C:\Users\uhds\VSCodeProjects\orchestratio`),
    row(String.raw`  ngrid-develop\docs\mockups\2026-09-03-pla`, true),
    row('  cement-class-deny.html', true),
  ];
  const found = findPathsInRows(rows, 43);
  assert.equal(found.length, 1);
  assert.equal(found[0].path, String.raw`C:\Users\uhds\VSCodeProjects\orchestrationgrid-develop\docs\mockups\2026-09-03-placement-class-deny.html`);
  assert.deepEqual(found[0].alternatives, ['cement-class-deny.html']);
  assert.deepEqual(
    { start: [found[0].startRow, found[0].startCol], end: [found[0].endRow, found[0].endCol] },
    { start: [0, 2], end: [2, 23] },
  );
});

test('FR-ARCH-012 AC-5: an ordinary path keeps no fallbacks; a wide gap or a row ending in a space is not joined', async () => {
  const { findPathsInRows } = await load();
  assert.deepEqual(findPathsInRows([row('see docs/a.md')], 40)[0].alternatives, []);
  // A real space falls at the start of a wrapped row: joined first, the piece kept as fallback.
  const joined = findPathsInRows([row('open docs/'), row(' a.md', true)], 10);
  assert.deepEqual(joined.map(found => [found.path, found.alternatives]), [['docs/a.md', ['a.md']]]);
  // More than four spaces is not an indent.
  assert.deepEqual(findPathsInRows([row('open docs/'), row('      a.md', true)], 10).map(found => found.path), ['a.md']);
  // The row above ends in a space, so nothing runs on.
  assert.deepEqual(findPathsInRows([row('open docs '), row('  a.md', true)], 10).map(found => found.path), ['a.md']);
});

test('FR-ARCH-012 AC-5: the indented pieces are joined even when the rows are not marked wrapped, as long as the row above is full', async () => {
  const { findPathsInRows } = await load();
  // ConPTY redraws the screen itself, so the pieces can arrive as separate rows.
  const rows = [
    row(String.raw`  C:\Users\uhds\VSCodeProjects\orchestratio`),
    row(String.raw`  ngrid-develop\docs\mockups\2026-09-03-pla`),
    row('  cement-class-deny.html'),
  ];
  const found = findPathsInRows(rows, 43);
  assert.deepEqual(found.map(hit => [hit.path, hit.alternatives]), [[
    String.raw`C:\Users\uhds\VSCodeProjects\orchestrationgrid-develop\docs\mockups\2026-09-03-placement-class-deny.html`,
    ['cement-class-deny.html'],
  ]]);
  // A row above that stops short of the edge does not run on.
  const short = [row('  see docs/'), row('  a.md')];
  assert.deepEqual(findPathsInRows(short, 43).map(hit => hit.path), ['a.md']);
});
