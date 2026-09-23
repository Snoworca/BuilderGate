import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as FileTreeStateModule from '../../src/components/fileExplorer/fileTreeState.ts';
import type { DirectoryEntry, DirectoryListing } from '../../src/types/index.ts';

// FR-FEX-001 / CON-FEX-001 / FR-FEX-002 AC-6·AC-7 / FR-FEX-011 AC-1·AC-4 /
// SEC-FOP-001 AC-4·AC-5 — the pure state behind useFileTree.
//
// The module is loaded inside each test rather than with a static import: a
// static import of a missing module kills the runner before any test is named,
// so a red run would show one crash instead of which contracts are unmet. The
// `import type` above is erased at runtime and exists so tsc checks every
// action literal below against the real action union once the module lands.
const MODULE_PATH = '../../src/components/fileExplorer/fileTreeState.ts';
type M = typeof FileTreeStateModule;
type State = FileTreeStateModule.FileTreeState;
type Rows = ReturnType<M['selectVisibleRows']>;

async function load(): Promise<M> {
  return await import(MODULE_PATH) as M;
}

// ---------------------------------------------------------------------------
// Fixtures — raw server responses, '..' included exactly as FileService sends
// it: first, type 'directory', only when the directory is not a drive root.
// ---------------------------------------------------------------------------

const MODIFIED = '2026-09-01T00:00:00.000Z';
const UP_ENTRY: DirectoryEntry = { name: '..', type: 'directory', size: 0, modified: MODIFIED };

function dir(name: string): DirectoryEntry {
  return { name, type: 'directory', size: 0, modified: MODIFIED };
}

function file(name: string, size: number): DirectoryEntry {
  return { name, type: 'file', size, modified: MODIFIED };
}

// Frozen because every test shares these fixtures: a reducer that strips '..'
// in place would otherwise corrupt later tests and fail somewhere unrelated.
// Frozen, it throws in the test that actually did the mutation.
function listing(path: string, entries: DirectoryEntry[], hasUp: boolean): DirectoryListing {
  const all = (hasUp ? [UP_ENTRY, ...entries] : entries).map((e) => Object.freeze({ ...e }));
  return Object.freeze({ cwd: path, path, entries: Object.freeze(all) as DirectoryEntry[], totalEntries: all.length });
}

const DRIVE = 'C:\\';
const WORK = 'C:\\work';
const ROOT = 'C:\\work\\repo';
const DOCS = 'C:\\work\\repo\\docs';
const SRC = 'C:\\work\\repo\\src';
const SRC2 = 'C:\\work\\repo\\src2';
const A_TXT = 'C:\\work\\repo\\a.txt';
const B_BIN = 'C:\\work\\repo\\b.bin';
const C_MD = 'C:\\work\\repo\\c.md';
const LIB = 'C:\\work\\repo\\src\\lib';
const INDEX_TS = 'C:\\work\\repo\\src\\index.ts';
const UTIL_TS = 'C:\\work\\repo\\src\\lib\\util.ts';

// Server order ('..', directories, files by name). Sizes are chosen so that a
// size-descending display order differs from this order: b.bin > c.md > a.txt.
const ROOT_LISTING = listing(ROOT, [
  dir('docs'), dir('src'), dir('src2'),
  file('a.txt', 10), file('b.bin', 5000), file('c.md', 300),
], true);
const SRC_LISTING = listing(SRC, [dir('lib'), file('index.ts', 20)], true);
const LIB_LISTING = listing(LIB, [file('util.ts', 30)], true);
const DOCS_LISTING = listing(DOCS, [file('guide.md', 40)], true);
const SRC2_LISTING = listing(SRC2, [file('x.ts', 50)], true);
const WORK_LISTING = listing(WORK, [dir('repo')], true);
const DRIVE_LISTING = listing(DRIVE, [dir('work')], false);

function loaded(m: M, state: State, path: string, raw: DirectoryListing): State {
  return m.fileTreeReducer(state, { type: 'CHILDREN_LOADED', path, listing: raw });
}

// Root loaded, 'src' expanded and loaded. Nothing selected, no anchor.
function seeded(m: M): State {
  let s = m.createInitialFileTreeState({ root: ROOT });
  s = loaded(m, s, ROOT, ROOT_LISTING);
  s = m.fileTreeReducer(s, { type: 'TOGGLE_EXPAND', path: SRC });
  s = loaded(m, s, SRC, SRC_LISTING);
  return s;
}

function nodePaths(rows: Rows): string[] {
  return rows.flatMap((row) => (row.kind === 'node' ? [row.path] : []));
}

// What a careless renderer would send: the up row mapped to a '..' string
// instead of being left out. The reducer must not trust it.
function naiveOrder(rows: Rows): string[] {
  return rows.map((row) => (row.kind === 'node' ? row.path : '..'));
}

function click(m: M, s: State, path: string, orderedPaths: string[], mods: { ctrl?: boolean; shift?: boolean } = {}): State {
  return m.fileTreeReducer(s, {
    type: 'CLICK_ROW',
    path,
    mods: { ctrl: mods.ctrl ?? false, shift: mods.shift ?? false },
    orderedPaths,
  });
}

function sorted(set: ReadonlySet<string>): string[] {
  return [...set].sort();
}

// ---------------------------------------------------------------------------
// FR-FEX-001
// ---------------------------------------------------------------------------

test('setRoot 와 goUp 커밋이 root 를 옮긴다 (root 는 가변)', async () => {
  const m = await load();
  let s = loaded(m, m.createInitialFileTreeState({ root: ROOT }), ROOT, ROOT_LISTING);

  s = m.fileTreeReducer(s, { type: 'SET_ROOT', path: SRC });
  assert.equal(s.root, SRC);
  s = m.fileTreeReducer(s, { type: 'SET_ROOT', path: ROOT });
  assert.equal(s.root, ROOT);

  // goUp = NAVIGATE_UP (pending) followed by NAVIGATE_COMMITTED once the parent listing arrived.
  s = m.fileTreeReducer(s, { type: 'NAVIGATE_UP' });
  s = loaded(m, s, WORK, WORK_LISTING);
  s = m.fileTreeReducer(s, { type: 'NAVIGATE_COMMITTED', path: WORK });
  assert.equal(s.root, WORK);
  assert.equal(s.pendingRoot, null);

  // Up again to the drive root: the parent of 'C:\work' is 'C:\', and the
  // children of 'C:\' join without a doubled separator.
  s = m.fileTreeReducer(s, { type: 'NAVIGATE_UP' });
  assert.equal(s.pendingRoot, DRIVE);
  s = loaded(m, s, DRIVE, DRIVE_LISTING);
  s = m.fileTreeReducer(s, { type: 'NAVIGATE_COMMITTED', path: DRIVE });
  assert.equal(s.root, DRIVE);
  assert.deepEqual(nodePaths(m.selectVisibleRows(s)), [WORK]);
});

test('selectVisibleRows: 트리는 뿌리+펼친 자손, 목록은 뿌리 직계만', async () => {
  const m = await load();
  let s = seeded(m);
  s = m.fileTreeReducer(s, { type: 'TOGGLE_EXPAND', path: LIB });
  s = loaded(m, s, LIB, LIB_LISTING);
  // An expanded, loaded directory outside the root is kept but never drawn.
  s = m.fileTreeReducer(s, { type: 'TOGGLE_EXPAND', path: WORK });
  s = loaded(m, s, WORK, WORK_LISTING);

  const tree = m.selectVisibleRows(s);
  // The up row is chrome: a sentinel with no path, so nothing keyed on a path can reach it.
  assert.equal(tree[0]?.kind, 'up');
  assert.equal('path' in (tree[0] as object), false);
  assert.deepEqual(
    tree.flatMap((row) => (row.kind === 'node' ? [[row.path, row.depth]] : [])),
    [
      [DOCS, 0], [SRC, 0], [LIB, 1], [UTIL_TS, 2], [INDEX_TS, 1],
      [SRC2, 0], [A_TXT, 0], [B_BIN, 0], [C_MD, 0],
    ],
  );

  // Collapsing 'src' hides 'lib' even though 'lib' stays expanded: every ancestor must be open.
  const collapsed = m.fileTreeReducer(s, { type: 'TOGGLE_EXPAND', path: SRC });
  assert.equal(collapsed.expandedPaths.has(LIB), true);
  assert.deepEqual(nodePaths(m.selectVisibleRows(collapsed)), [DOCS, SRC, SRC2, A_TXT, B_BIN, C_MD]);

  const list = m.selectVisibleRows(m.fileTreeReducer(s, { type: 'SET_MODE', mode: 'list' }));
  assert.equal(list[0]?.kind, 'up');
  assert.deepEqual(
    list.flatMap((row) => (row.kind === 'node' ? [[row.path, row.depth]] : [])),
    [[DOCS, 0], [SRC, 0], [SRC2, 0], [A_TXT, 0], [B_BIN, 0], [C_MD, 0]],
  );
});

test('SET_MODE 전후 childrenByPath 가 같은 참조이고 fetch 요청 액션을 만들지 않는다', async () => {
  const m = await load();
  const before = seeded(m);
  const list = m.fileTreeReducer(before, { type: 'SET_MODE', mode: 'list' });
  const back = m.fileTreeReducer(list, { type: 'SET_MODE', mode: 'tree' });

  assert.equal(list.mode, 'list');
  assert.equal(back.mode, 'tree');
  // SET_MODE writes mode and nothing else — every other field is the same value/reference.
  for (const [prev, next] of [[before, list], [list, back]] as const) {
    for (const key of Object.keys(prev) as (keyof State)[]) {
      if (key === 'mode') continue;
      assert.ok(Object.is(prev[key], next[key]), `SET_MODE changed ${String(key)}`);
    }
  }
  // Both views read the same cache, so nothing visible needs a request after the switch.
  for (const state of [list, back]) {
    assert.equal(m.shouldFetchChildren(state.childrenByPath, ROOT, { isRefresh: false }), false);
    assert.equal(m.shouldFetchChildren(state.childrenByPath, SRC, { isRefresh: false }), false);
  }
});

test('뿌리를 바꿨다 되돌아와도 expandedPaths 가 그대로다', async () => {
  const m = await load();
  let s = seeded(m);
  s = loaded(m, s, WORK, WORK_LISTING);

  s = m.fileTreeReducer(s, { type: 'SET_ROOT', path: WORK });
  assert.equal(s.expandedPaths.has(SRC), true);
  s = m.fileTreeReducer(s, { type: 'SET_ROOT', path: ROOT });
  assert.equal(s.expandedPaths.has(SRC), true);
  assert.deepEqual(
    nodePaths(m.selectVisibleRows(s)),
    [DOCS, SRC, LIB, INDEX_TS, SRC2, A_TXT, B_BIN, C_MD],
  );
});

test('shouldFetchChildren 표: 없음=true, loading/loaded/error=false, refresh=true', async () => {
  const m = await load();
  let s = m.createInitialFileTreeState({ root: ROOT });
  s = loaded(m, s, ROOT, ROOT_LISTING);
  s = m.fileTreeReducer(s, { type: 'CHILDREN_LOADING', path: DOCS });
  s = m.fileTreeReducer(s, { type: 'CHILDREN_FAILED', path: SRC2, error: 'EACCES' });
  const map = s.childrenByPath;

  const table: [string, string, boolean, boolean][] = [
    ['absent', SRC, false, true],
    ['loading', DOCS, false, false],
    ['loaded', ROOT, false, false],
    ['error', SRC2, false, false],
    ['absent + refresh', SRC, true, true],
    ['loaded + refresh', ROOT, true, true],
    ['error + refresh', SRC2, true, true],
  ];
  for (const [label, path, isRefresh, expected] of table) {
    assert.equal(m.shouldFetchChildren(map, path, { isRefresh }), expected, label);
  }
});

test('INVALIDATE_DIRECTORIES 가 affectedDirectories 만 비우고 형제 항목은 남긴다 (구분자 정규화 포함)', async () => {
  const m = await load();
  let s = seeded(m);
  s = loaded(m, s, LIB, LIB_LISTING);
  s = loaded(m, s, DOCS, DOCS_LISTING);
  s = loaded(m, s, SRC2, SRC2_LISTING);
  const expandedBefore = sorted(s.expandedPaths);

  // The job report may spell the directory with forward slashes and a trailing separator.
  s = m.fileTreeReducer(s, { type: 'INVALIDATE_DIRECTORIES', affectedDirectories: ['C:/work/repo/src/'] });
  const fetch = (path: string) => m.shouldFetchChildren(s.childrenByPath, path, { isRefresh: false });
  assert.equal(fetch(SRC), true, 'the affected directory is emptied');
  assert.equal(fetch(ROOT), false, 'its parent stays');
  assert.equal(fetch(DOCS), false, 'a sibling stays');
  assert.equal(fetch(SRC2), false, 'a sibling sharing the name prefix stays');
  assert.equal(fetch(LIB), false, 'its own child is not affected unless listed');
  assert.deepEqual(sorted(s.expandedPaths), expandedBefore, 'invalidation does not collapse anything');

  s = m.fileTreeReducer(s, { type: 'INVALIDATE_DIRECTORIES', affectedDirectories: [DOCS] });
  assert.equal(fetch(DOCS), true);
  assert.equal(fetch(SRC2), false);
});

// ---------------------------------------------------------------------------
// CON-FEX-001 — '..' is window chrome, never a node
// ---------------------------------------------------------------------------

test("normalizeDirectoryEntries 가 '..' 를 노드로 만들지 않는다 — childrenByPath 어디에도 '..' 없음", async () => {
  const m = await load();
  let s = seeded(m);
  s = loaded(m, s, WORK, WORK_LISTING);
  s = loaded(m, s, DRIVE, DRIVE_LISTING);

  assert.equal(m.normalizeDirectoryEntries(ROOT_LISTING.entries).entries.some((e) => e.name === '..'), false);
  let loadedCount = 0;
  for (const [path, child] of s.childrenByPath) {
    if (child.status !== 'loaded') continue;
    loadedCount += 1;
    assert.equal(child.entries.some((e) => e.name === '..'), false, `'..' stored under ${path}`);
  }
  assert.equal(loadedCount, 4, 'every loaded listing was inspected');
  for (const path of nodePaths(m.selectVisibleRows(s))) {
    assert.equal(path.endsWith('..'), false, `row path ${path}`);
  }
});

test("보이는 행에 없는 경로('..' 결합 경로 포함)로 온 선택 액션은 무시된다", async () => {
  const m = await load();
  const base = seeded(m);
  const rendered = nodePaths(m.selectVisibleRows(base));
  const selected = click(m, base, DOCS, rendered);
  assert.deepEqual(sorted(selected.selectedPaths), [DOCS]);

  // Each bogus path is also put into orderedPaths, so a reducer that trusts
  // the action's list instead of the visible rows is caught.
  const notVisible = ['..', `${ROOT}\\..`, UTIL_TS];
  for (const bogus of notVisible) {
    for (const mods of [{}, { ctrl: true }, { shift: true }]) {
      const next = click(m, selected, bogus, [bogus, ...rendered], mods);
      assert.deepEqual(sorted(next.selectedPaths), [DOCS], `${bogus} ${JSON.stringify(mods)}`);
      assert.equal(next.anchorPath, DOCS, `${bogus} ${JSON.stringify(mods)} moved the anchor`);
    }
  }
});

test('selectAll 과 첫 행부터의 Shift 범위가 up 센티널을 포함하지 않는다', async () => {
  const m = await load();
  const base = seeded(m);
  const rows = m.selectVisibleRows(base);
  const nodes = nodePaths(rows);
  const order = naiveOrder(rows);
  assert.equal(order[0], '..', 'fixture: the up row is first');

  const all = m.fileTreeReducer(base, { type: 'SELECT_ALL', orderedPaths: order });
  assert.deepEqual(sorted(all.selectedPaths), [...nodes].sort());

  // Shift without an anchor ranges from the first row. The first row is the up
  // sentinel, so the range starts at the first node instead.
  const range = click(m, base, nodes[2]!, order, { shift: true });
  assert.deepEqual(sorted(range.selectedPaths), nodes.slice(0, 3).sort());
});

test("목록 모드 sort {size, desc}: SELECT_ALL(orderedPaths=렌더된 행) 이 정확히 렌더된 비-'..' 행 집합만 고른다", async () => {
  const m = await load();
  // 'src' is expanded and loaded, so its children sit in the cache but are not rendered in list mode.
  const s = m.fileTreeReducer(seeded(m), { type: 'SET_MODE', mode: 'list' });
  const renderedBySizeDesc = ['..', DOCS, SRC, SRC2, B_BIN, C_MD, A_TXT];

  const all = m.fileTreeReducer(s, { type: 'SELECT_ALL', orderedPaths: renderedBySizeDesc });
  assert.deepEqual(sorted(all.selectedPaths), [A_TXT, B_BIN, C_MD, DOCS, SRC, SRC2].sort());
});

test("hasParent 는 원본 '..' 유무만 반영하고 노드 수를 바꾸지 않는다", async () => {
  const m = await load();
  // '..hidden' is an ordinary name; only the exact '..' entry is the parent marker.
  const raw = [UP_ENTRY, dir('docs'), file('..hidden', 1), file('a.txt', 2)];
  const withUp = m.normalizeDirectoryEntries(raw);
  assert.equal(withUp.hasParent, true);
  assert.deepEqual(withUp.entries.map((e) => e.name), ['docs', '..hidden', 'a.txt']);

  const withoutUp = m.normalizeDirectoryEntries(raw.slice(1));
  assert.equal(withoutUp.hasParent, false);
  assert.deepEqual(withoutUp.entries.map((e) => e.name), ['docs', '..hidden', 'a.txt']);

  // Through the reducer: the node count of a listing with '..' is raw length minus one.
  const s = loaded(m, m.createInitialFileTreeState({ root: ROOT }), ROOT, ROOT_LISTING);
  assert.equal(nodePaths(m.selectVisibleRows(s)).length, ROOT_LISTING.entries.length - 1);
});

// ---------------------------------------------------------------------------
// FR-FEX-011 / FR-FEX-002 — selection
// ---------------------------------------------------------------------------

test('applyRowClick 표: 단일=교체, Ctrl=토글, Shift=앵커부터 범위', async () => {
  const m = await load();
  const base = seeded(m);
  const order = nodePaths(m.selectVisibleRows(base));
  // order = docs, src, src\lib, src\index.ts, src2, a.txt, b.bin, c.md

  let s = click(m, base, DOCS, order);
  assert.deepEqual(sorted(s.selectedPaths), [DOCS]);
  assert.equal(s.anchorPath, DOCS);

  s = click(m, s, C_MD, order);
  assert.deepEqual(sorted(s.selectedPaths), [C_MD], 'a plain click replaces');
  assert.equal(s.anchorPath, C_MD);

  s = click(m, s, A_TXT, order, { ctrl: true });
  assert.deepEqual(sorted(s.selectedPaths), [A_TXT, C_MD].sort(), 'ctrl adds');
  assert.equal(s.anchorPath, A_TXT);

  s = click(m, s, C_MD, order, { ctrl: true });
  assert.deepEqual(sorted(s.selectedPaths), [A_TXT], 'ctrl on a selected row removes it');

  s = click(m, s, SRC2, order);
  s = click(m, s, B_BIN, order, { shift: true });
  assert.deepEqual(sorted(s.selectedPaths), [SRC2, A_TXT, B_BIN].sort(), 'shift ranges down from the anchor');
  assert.equal(s.anchorPath, SRC2, 'shift keeps the anchor');

  s = click(m, s, SRC, order, { shift: true });
  assert.deepEqual(
    sorted(s.selectedPaths),
    [SRC, LIB, INDEX_TS, SRC2].sort(),
    'a second shift replaces the previous range, upward this time',
  );
  assert.equal(s.anchorPath, SRC2);
});

test('목록 모드 sort {size, desc}: Shift 범위가 서버 순서가 아니라 CLICK_ROW 가 실어 온 표시 순서(orderedPaths)에서 앵커~대상 사이만 고른다', async () => {
  const m = await load();
  const s = m.fileTreeReducer(seeded(m), { type: 'SET_MODE', mode: 'list' });
  // Server order: docs, src, src2, a.txt, b.bin, c.md. Display (size desc, directories first):
  const display = [DOCS, SRC, SRC2, B_BIN, C_MD, A_TXT];

  const down = click(m, click(m, s, B_BIN, display), A_TXT, display, { shift: true });
  assert.deepEqual(sorted(down.selectedPaths), [A_TXT, B_BIN, C_MD].sort());

  // In server order c.md..a.txt would span b.bin; in display order it does not.
  const up = click(m, click(m, s, A_TXT, display), C_MD, display, { shift: true });
  assert.deepEqual(sorted(up.selectedPaths), [A_TXT, C_MD].sort());
});

test('TOGGLE_EXPAND(삼각형) 가 selectedPaths 를 바꾸지 않는다', async () => {
  const m = await load();
  const base = seeded(m);
  const order = nodePaths(m.selectVisibleRows(base));

  let s = click(m, base, DOCS, order);
  s = m.fileTreeReducer(s, { type: 'TOGGLE_EXPAND', path: SRC2 });
  assert.equal(s.expandedPaths.has(SRC2), true);
  assert.deepEqual(sorted(s.selectedPaths), [DOCS]);
  assert.equal(s.anchorPath, DOCS);
  s = m.fileTreeReducer(s, { type: 'TOGGLE_EXPAND', path: SRC2 });
  assert.equal(s.expandedPaths.has(SRC2), false);
  assert.deepEqual(sorted(s.selectedPaths), [DOCS]);

  // Toggling the selected directory itself neither deselects nor reselects it.
  let t = click(m, base, SRC, order);
  t = m.fileTreeReducer(t, { type: 'TOGGLE_EXPAND', path: SRC });
  assert.equal(t.expandedPaths.has(SRC), false);
  assert.deepEqual(sorted(t.selectedPaths), [SRC]);
  assert.equal(t.anchorPath, SRC);
});

test('SET_MODE 전후 selectedPaths 가 유지된다', async () => {
  const m = await load();
  const base = seeded(m);
  const order = nodePaths(m.selectVisibleRows(base));
  const s = click(m, click(m, base, DOCS, order), A_TXT, order, { ctrl: true });

  const list = m.fileTreeReducer(s, { type: 'SET_MODE', mode: 'list' });
  assert.deepEqual(sorted(list.selectedPaths), [A_TXT, DOCS].sort());
  const tree = m.fileTreeReducer(list, { type: 'SET_MODE', mode: 'tree' });
  assert.deepEqual(sorted(tree.selectedPaths), [A_TXT, DOCS].sort());
});

test("createInitialFileTreeState 의 기본 mode 는 'tree'", async () => {
  const m = await load();
  assert.equal(m.createInitialFileTreeState({ root: ROOT }).mode, 'tree');
  // The default is a default, not a constant.
  assert.equal(m.createInitialFileTreeState({ root: ROOT, mode: 'list' }).mode, 'list');
});

// ---------------------------------------------------------------------------
// SEC-FOP-001 — the client holds no copy of the boundary rule
// ---------------------------------------------------------------------------

test("canGoUp 은 뿌리 목록의 hasParent 플래그만 읽는다 — 경로 비교 없음, '..' 없는 응답이면 false", async () => {
  const m = await load();
  const at = (root: string, raw?: DirectoryListing) => {
    const s = m.createInitialFileTreeState({ root });
    return raw ? loaded(m, s, root, raw) : s;
  };

  const cases: [string, State, boolean][] = [
    ['nothing loaded yet', at(ROOT), false],
    ['sub-directory, response has ..', at(ROOT, ROOT_LISTING), true],
    ['drive root, response has no ..', at(DRIVE, DRIVE_LISTING), false],
    // A path comparison ("is this a drive root?") gets the next two wrong.
    ['sub-directory, response has no ..', at(WORK, listing(WORK, [dir('repo')], false)), false],
    ['drive root, response has ..', at(DRIVE, listing(DRIVE, [dir('work')], true)), true],
  ];
  for (const [label, state, expected] of cases) {
    assert.equal(m.canGoUp(state), expected, label);
    assert.equal(state.rootHasParent, expected, `${label}: rootHasParent`);
  }
});

test('NAVIGATE_UP 은 pending 만 세우고, 실패하면 root 유지+error, 성공하면 commit', async () => {
  const m = await load();
  const s = loaded(m, m.createInitialFileTreeState({ root: ROOT }), ROOT, ROOT_LISTING);

  const pending = m.fileTreeReducer(s, { type: 'NAVIGATE_UP' });
  assert.equal(pending.root, ROOT, 'the root does not move before the parent is listed');
  assert.equal(pending.pendingRoot, WORK);
  assert.equal(pending.childrenByPath, s.childrenByPath);

  // '↑' being enabled does not promise the parent can be listed.
  const failed = m.fileTreeReducer(pending, { type: 'NAVIGATE_FAILED', path: WORK, error: 'EACCES: blocked path' });
  assert.equal(failed.root, ROOT);
  assert.equal(failed.pendingRoot, null);
  assert.equal(failed.error, 'EACCES: blocked path');
  assert.deepEqual(nodePaths(m.selectVisibleRows(failed)), nodePaths(m.selectVisibleRows(s)));

  let retried = m.fileTreeReducer(failed, { type: 'NAVIGATE_UP' });
  retried = loaded(m, retried, WORK, WORK_LISTING);
  const committed = m.fileTreeReducer(retried, { type: 'NAVIGATE_COMMITTED', path: WORK });
  assert.equal(committed.root, WORK);
  assert.equal(committed.pendingRoot, null);
  assert.equal(committed.error, null, 'a successful move clears the earlier error');
  assert.equal(m.canGoUp(committed), true, 'the new root listing decides the up button');

  // Committing to the drive root turns '↑' off from that root's own listing.
  let top = m.fileTreeReducer(committed, { type: 'NAVIGATE_UP' });
  top = loaded(m, top, DRIVE, DRIVE_LISTING);
  top = m.fileTreeReducer(top, { type: 'NAVIGATE_COMMITTED', path: DRIVE });
  assert.equal(m.canGoUp(top), false);
});
