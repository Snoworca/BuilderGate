import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type * as FileListViewModule from '../../src/components/fileExplorer/fileListView.ts';
import { createInitialFileTreeState, fileTreeReducer } from '../../src/components/fileExplorer/fileTreeState.ts';
import type { FileTreeState } from '../../src/components/fileExplorer/fileTreeState.ts';
import type { DirectoryEntry, DirectoryListing } from '../../src/types/index.ts';

// FR-FEX-002 AC-2·AC-3·AC-4·AC-8 — the pure view model behind list mode.
//
// Loaded inside each test for the same reason as fileTreeState.test.ts: a static
// import of a missing module crashes the runner before any test is named, so a
// red run would not say which contract is unmet. The `import type` is erased at
// runtime and lets tsc check the calls below once the module exists.
const MODULE_PATH = '../../src/components/fileExplorer/fileListView.ts';
type M = typeof FileListViewModule;

async function load(): Promise<M> {
  return await import(MODULE_PATH) as M;
}

type SortKey = 'name' | 'modified' | 'size';
type SortDir = 'asc' | 'desc';

// Frozen so an in-place Array.prototype.sort on caller data throws here instead
// of silently reordering the server's listing for every later reader.
function frozen(entries: DirectoryEntry[]): DirectoryEntry[] {
  return Object.freeze(entries.map((e) => Object.freeze({ ...e }))) as DirectoryEntry[];
}

// Chosen so that every naive shortcut picks a visibly wrong order:
// - '가.md' / 'B.md' / 'a.txt': 'ko' collation puts Hangul first and ignores case;
//   code-point order ('B' < 'a' < '가') and the default locale disagree.
// - sizes 9 / 20 / 100 / 300: string comparison would put "100" before "9".
// - for every key and both directions, a sort that ignores `type` interleaves a
//   file among the directories, so "directories first" cannot pass by accident.
// Directory sizes are distinct only so the size ordering has no ties to specify.
const M_DIR: DirectoryEntry = { name: 'm-dir', type: 'directory', size: 50, modified: '2026-05-01T00:00:00.000Z' };
const B_DIR: DirectoryEntry = { name: 'b-dir', type: 'directory', size: 5, modified: '2026-01-01T00:00:00.000Z' };
const A_TXT: DirectoryEntry = { name: 'a.txt', type: 'file', size: 9, extension: '.txt', modified: '2026-03-01T00:00:00.000Z' };
const Z_LOG: DirectoryEntry = { name: 'z.log', type: 'file', size: 100, extension: '.log', modified: '2026-12-01T00:00:00.000Z' };
const GA_MD: DirectoryEntry = { name: '가.md', type: 'file', size: 20, extension: '.md', modified: '2026-07-01T00:00:00.000Z' };
const UB_MD: DirectoryEntry = { name: 'B.md', type: 'file', size: 300, extension: '.md', modified: '2026-09-01T00:00:00.000Z' };

// Server order is directories then files, but deliberately NOT name-sorted inside
// each group, so a client that re-sorts on "no sort" is caught.
const SERVER_ORDER = frozen([M_DIR, B_DIR, Z_LOG, A_TXT, UB_MD, GA_MD]);

// Expected orders written out by hand, not computed with the comparator under test.
const EXPECTED: Record<SortKey, Record<SortDir, string[]>> = {
  name: {
    asc: ['b-dir', 'm-dir', '가.md', 'a.txt', 'B.md', 'z.log'],
    desc: ['m-dir', 'b-dir', 'z.log', 'B.md', 'a.txt', '가.md'],
  },
  modified: {
    asc: ['b-dir', 'm-dir', 'a.txt', '가.md', 'B.md', 'z.log'],
    desc: ['m-dir', 'b-dir', 'z.log', 'B.md', '가.md', 'a.txt'],
  },
  size: {
    asc: ['b-dir', 'm-dir', 'a.txt', '가.md', 'z.log', 'B.md'],
    desc: ['m-dir', 'b-dir', 'B.md', 'z.log', '가.md', 'a.txt'],
  },
};

const names = (entries: readonly { name: string }[]): string[] => entries.map((e) => e.name);

test('toListRow 가 name·modified·size 세 필드만 낸다 + LIST_COLUMNS 순서', async () => {
  const { toListRow, LIST_COLUMNS } = await load();

  // No type column (design §8.4): the extension is already in the name.
  assert.deepEqual([...LIST_COLUMNS], ['name', 'modified', 'size']);

  // A_TXT carries `type` and `extension`, so handing the entry back unchanged fails.
  const row = toListRow(A_TXT);
  assert.deepEqual(Object.keys(row).sort(), ['modified', 'name', 'size']);
  assert.equal(row.name, 'a.txt');
  assert.equal(row.modified, '2026-03-01T00:00:00.000Z');
  assert.equal(row.size, 9);
  // Every column has a cell and every cell has a column.
  assert.deepEqual(new Set(Object.keys(row)), new Set(LIST_COLUMNS));
});

test('sortEntries(entries, null) 은 서버 순서를 그대로 둔다', async () => {
  const { sortEntries } = await load();

  const result = sortEntries(SERVER_ORDER, null);
  // Not name order within groups: a client-side default sort would produce
  // ['b-dir','m-dir',...] and fail here.
  assert.deepEqual(names(result), ['m-dir', 'b-dir', 'z.log', 'a.txt', 'B.md', '가.md']);
  // The listing itself is untouched (it is frozen; an in-place sort would throw).
  assert.deepEqual(names(SERVER_ORDER), ['m-dir', 'b-dir', 'z.log', 'a.txt', 'B.md', '가.md']);
});

test('sortEntries 세 키 x 두 방향: 디렉터리가 항상 파일 앞', async () => {
  const { sortEntries, compareListRows, LIST_COLUMNS } = await load();

  for (const key of LIST_COLUMNS) {
    for (const dir of ['asc', 'desc'] as const) {
      const sorted = sortEntries(SERVER_ORDER, { key, dir });
      const label = `${key} ${dir}`;
      // Printed before the order assertion so a failure shows the actual order.
      const firstFile = sorted.findIndex((e) => e.type === 'file');
      const lastDir = sorted.map((e) => e.type).lastIndexOf('directory');
      assert.ok(lastDir < firstFile, `${label}: a file precedes a directory in ${JSON.stringify(names(sorted))}`);
      assert.deepEqual(names(sorted), EXPECTED[key][dir], label);
      // Sorting is a view, not a mutation of the listing.
      assert.deepEqual(names(SERVER_ORDER), ['m-dir', 'b-dir', 'z.log', 'a.txt', 'B.md', '가.md'], `${label}: input mutated`);
    }
  }

  // The comparator reused by scroll restore obeys the same rule on its own:
  // descending by name would put 'z.log' before 'b-dir' if type came second.
  const nameDesc = { key: 'name', dir: 'desc' } as const;
  assert.ok(compareListRows(B_DIR, Z_LOG, nameDesc) < 0, 'directory must sort before file under name desc');
  assert.ok(compareListRows(Z_LOG, B_DIR, nameDesc) > 0, 'file must sort after directory under name desc');
  const sizeAsc = { key: 'size', dir: 'asc' } as const;
  assert.ok(compareListRows(M_DIR, A_TXT, sizeAsc) < 0, 'directory (50) must sort before file (9) under size asc');
});

// The row cap the list must honour. Read from the shipped config rather than
// restated, so raising maxDirectoryEntries makes this fixture follow it.
function maxDirectoryEntries(): number {
  const config = readFileSync(new URL('../../../server/config.json5', import.meta.url), 'utf8');
  const match = /maxDirectoryEntries\s*:\s*(\d+)/.exec(config);
  assert.ok(match, 'maxDirectoryEntries not found in server/config.json5');
  return Number(match[1]);
}

const ROOT = 'C:\\work\\big';

function bigListing(count: number): DirectoryListing {
  const entries: DirectoryEntry[] = [
    // The parent marker, exactly as FileService sends it for a non-drive-root.
    { name: '..', type: 'directory', size: 0, modified: '2026-09-01T00:00:00.000Z' },
    { name: 'sub', type: 'directory', size: 0, modified: '2026-09-01T00:00:00.000Z' },
  ];
  for (let i = 1; i < count; i += 1) {
    entries.push({ name: `f${String(i).padStart(5, '0')}.txt`, type: 'file', size: i, modified: '2026-09-01T00:00:00.000Z' });
  }
  return { cwd: ROOT, path: ROOT, entries: frozen(entries), totalEntries: entries.length };
}

test('selectListRows 가 10000 항목 fixture 에서 10000 행을 돌려준다 — 잘라내기·창 계산 없음', async () => {
  const { selectListRows } = await load();
  const count = maxDirectoryEntries();
  assert.equal(count, 10000);

  let state: FileTreeState = createInitialFileTreeState({ root: ROOT, mode: 'list' });
  state = fileTreeReducer(state, { type: 'CHILDREN_LOADED', path: ROOT, listing: bigListing(count) });
  // An open, loaded subdirectory: list mode shows direct children only, so its
  // child must not add a row.
  state = fileTreeReducer(state, { type: 'TOGGLE_EXPAND', path: `${ROOT}\\sub` });
  state = fileTreeReducer(state, {
    type: 'CHILDREN_LOADED',
    path: `${ROOT}\\sub`,
    listing: { cwd: `${ROOT}\\sub`, path: `${ROOT}\\sub`, entries: [{ name: 'deep.txt', type: 'file', size: 1, modified: '2026-09-01T00:00:00.000Z' }], totalEntries: 1 },
  });
  assert.equal(state.rootHasParent, true);

  const rows = selectListRows(state, null);
  // Logged before asserting so a windowed result shows how much it kept.
  const expectedNames = ['sub', ...Array.from({ length: count - 1 }, (_, i) => `f${String(i + 1).padStart(5, '0')}.txt`)];
  assert.equal(rows.length, count, `rows=${rows.length} expected=${count}`);
  // Every entry, in server order — not just the right count of something.
  assert.deepEqual(names(rows), expectedNames);
  // Rows keep what the list draws and acts on: a result reduced to bare names
  // would pass the checks above and leave the size/date columns and the
  // directory double-click with nothing to read.
  assert.equal(rows[0].type, 'directory');
  assert.equal(rows[1].type, 'file');
  assert.equal(rows[1].size, 1);
  assert.equal(rows[1].modified, '2026-09-01T00:00:00.000Z');
  // '..' is chrome drawn outside the node rows (DR-09), even though the
  // directory has a parent; it is neither a row nor a sort participant.
  assert.equal(rows.some((r) => r.name === '..' || ('kind' in r && r.kind === 'up')), false);

  // A header sort changes order only, never the count.
  const sorted = selectListRows(state, { key: 'size', dir: 'desc' });
  assert.equal(sorted.length, count);
  assert.equal(sorted[0].name, 'sub');
  assert.equal(sorted[1].name, `f${String(count - 1).padStart(5, '0')}.txt`);
  assert.equal(sorted[count - 1].name, 'f00001.txt');
});

test('디렉터리 아이콘은 폴더 이모지다 — 닫히면 📁, 펼치면 📂, 파일은 · 그대로', async () => {
  const m = await import(MODULE_PATH) as typeof FileListViewModule;
  assert.equal(m.entryIcon({ isDirectory: true, expanded: false }), '📁');
  assert.equal(m.entryIcon({ isDirectory: true, expanded: true }), '📂');
  assert.equal(m.entryIcon({ isDirectory: false, expanded: false }), '·');
  // A file is never "open": expanded is ignored for it.
  assert.equal(m.entryIcon({ isDirectory: false, expanded: true }), '·');
});

test('트리와 목록 뷰가 아이콘을 entryIcon 으로 그린다(파란 삼각형 ▸ 를 쓰지 않는다)', () => {
  for (const file of ['FileTreeView.tsx', 'FileListView.tsx']) {
    const source = readFileSync(new URL(`../../src/components/fileExplorer/${file}`, import.meta.url), 'utf8');
    assert.match(source, /className="fx-icon">\{entryIcon\(/, `${file} must draw the row icon with entryIcon`);
    assert.doesNotMatch(source, /'▸'/, `${file} still draws the triangle`);
  }
});

test('트리 뷰는 행마다 깊이만큼 세로 안내선(fx-guide)을 부모 펼침 화살표 중심에 긋는다', () => {
  const tree = readFileSync(new URL('../../src/components/fileExplorer/FileTreeView.tsx', import.meta.url), 'utf8');
  assert.match(tree, /Array\.from\(\{ length: row\.depth \}/, 'one guide per ancestor level');
  assert.match(tree, /className="fx-guide"/, 'the guide element');
  const css = readFileSync(new URL('../../src/components/fileExplorer/FileExplorer.css', import.meta.url), 'utf8');
  const guide = /\.fx-guide\s*\{([^}]*)\}/.exec(css);
  assert.ok(guide, '.fx-guide rule');
  assert.match(guide[1], /position:\s*absolute/);
  assert.match(guide[1], /width:\s*1px/);
  assert.match(guide[1], /background:\s*var\(--line-strong\)/, 'a token colour, visible on both surfaces');
  assert.match(css, /\.fx-row\s*\{[^}]*position:\s*relative/, 'guides are placed against the row');
});

test('행 글자·날짜·크기·화살표는 가장 흐린 색(--fg-faint)을 쓰지 않는다', () => {
  const css = readFileSync(new URL('../../src/components/fileExplorer/FileExplorer.css', import.meta.url), 'utf8');
  for (const selector of ['.fx-meta', '.fx-expander', '.fx-name']) {
    const rule = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(rule, `${selector} rule`);
    assert.doesNotMatch(rule[1], /--fg-faint/, `${selector} is too faint to read`);
  }
  assert.match(/\.fx-name\s*\{([^}]*)\}/.exec(css)![1], /color:\s*var\(--fg-strong\)/, 'names read at full strength');
});
