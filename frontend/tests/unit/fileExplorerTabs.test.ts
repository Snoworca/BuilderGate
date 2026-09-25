import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import type * as TabsModule from '../../src/components/fileExplorer/fileExplorerTabsState.ts';
import type * as ScrollModule from '../../src/components/fileExplorer/fileExplorerScrollRestore.ts';
import type * as StorageModule from '../../src/hooks/windowStateStorage.ts';
import type { ListSort } from '../../src/components/fileExplorer/fileListView.ts';
import type { DirectoryEntry } from '../../src/types/index.ts';

// FR-FEX-003 AC-3·AC-4·AC-6~AC-11 / FR-FEX-002 AC-7 — the explorer's tabs, what
// each tab keeps between page loads, and how its scroll position comes back.
//
// Three modules are under test:
// - fileExplorerTabsState.ts: the tab list. Each tab owns its own FileTreeState,
//   so two tabs can look at two different roots (AC-3).
// - windowStateStorage.ts: gains a second, separate key for the explorer
//   (`file_explorer_state_{workspaceId}`) with the same conventions as the
//   editor's: a {schemaVersion, …, savedAt} envelope, an injectable storage, and
//   null for anything unusable. The editor's key and schema must not move — a
//   change there would silently drop every user's saved editor windows.
// - fileExplorerScrollRestore.ts: scroll comes back by anchor (the name of the
//   top visible row), never by pixels (design §9.2, decision 23).
//
// The failure this file exists to stop is the one Orca recorded as STA-5949: a
// restore that could not find its anchor wrote "top" back into storage, turning
// a late paint into permanent loss. Here that is pinned as the decisions that
// gate every write: a restore that missed its anchor says shouldPersist:false,
// and a programmatic (fallback) scroll never decides 'save'.
//
// Expected key sets and prefixes are written out here rather than read from the
// modules, so an implementation that adds a field or renames a key is caught
// instead of followed.
//
// Modules are loaded inside each test: a static import of a module that does
// not exist yet crashes the runner before any test is named, and red must be
// reported test by test.

const TABS_PATH = '../../src/components/fileExplorer/fileExplorerTabsState.ts';
const SCROLL_PATH = '../../src/components/fileExplorer/fileExplorerScrollRestore.ts';
const STORAGE_PATH = '../../src/hooks/windowStateStorage.ts';

type Tabs = typeof TabsModule;
type Scroll = typeof ScrollModule;
type Store = typeof StorageModule;

async function loadTabs(): Promise<Tabs> {
  return await import(TABS_PATH) as Tabs;
}
async function loadScroll(): Promise<Scroll> {
  return await import(SCROLL_PATH) as Scroll;
}
async function loadStore(): Promise<Store> {
  return await import(STORAGE_PATH) as Store;
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  keys(): string[] {
    return Array.from(this.values.keys()).sort();
  }
}

// The key prefixes. The explorer's is the one the plan names; the editor's is
// the one windowStateStorage.test.ts already pins, repeated so this file can
// assert the two never collide.
const EXPLORER_KEY_PREFIX = 'file_explorer_state_';
const EDITOR_KEY_PREFIX = 'window_state_';

// Exactly what one stored tab may carry. No expandedPaths (AC-7), no pixel
// offset of any kind (AC-8), no session id (a session id means nothing after a
// reload; the tab is re-bound through originTabId).
const TAB_RECORD_FIELDS = ['id', 'mode', 'originTabId', 'root', 'scrollAnchor', 'sort'];
const ENVELOPE_FIELDS = ['activeTabId', 'savedAt', 'schemaVersion', 'tabs'];

const WS_A = 'ws-a';
const WS_B = 'ws-b';
const SESSION_1 = 'sess-1';
const SESSION_2 = 'sess-2';
const CWD_1 = 'C:\\work\\repo';
const CWD_2 = 'C:\\work\\other';
const DOCS = 'C:\\work\\repo\\docs';
const SRC = 'C:\\work\\repo\\src';

const BY_NAME_ASC: ListSort = { key: 'name', dir: 'asc' };
const BY_NAME_DESC: ListSort = { key: 'name', dir: 'desc' };
const BY_SIZE_DESC: ListSort = { key: 'size', dir: 'desc' };

const MODIFIED = '2026-09-01T00:00:00.000Z';
function file(name: string, size = 1): DirectoryEntry {
  return { name, type: 'file', size, modified: MODIFIED };
}

// A tab as the app holds it just before saving: the six record fields plus the
// things the store must drop. Inferred type on purpose — annotating it as the
// record type would make the compiler reject the extras, and what is watched
// here is what the serializer does with them at run time.
function liveTabRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fx-tab-1',
    originTabId: 'term-1',
    root: DOCS,
    mode: 'list' as const,
    sort: BY_SIZE_DESC,
    scrollAnchor: 'report.md',
    expandedPaths: [`${DOCS}\\drafts`, `${DOCS}\\old`],
    scrollTop: 48213,
    sessionId: SESSION_1,
    ...overrides,
  };
}

function rawStored(storage: Storage, workspaceId: string): string {
  const raw = storage.getItem(EXPLORER_KEY_PREFIX + workspaceId);
  assert.notEqual(raw, null, `${EXPLORER_KEY_PREFIX}${workspaceId} 에 저장된 값이 없다`);
  return raw as string;
}

function storedTabs(storage: Storage, workspaceId: string): Record<string, unknown>[] {
  const parsed = JSON.parse(rawStored(storage, workspaceId)) as { tabs?: unknown };
  assert.equal(Array.isArray(parsed.tabs), true, '저장된 값에서 tabs 배열을 찾지 못했다');
  return parsed.tabs as Record<string, unknown>[];
}

function numberLeaves(value: unknown, path = '$', found: string[] = []): string[] {
  if (typeof value === 'number') found.push(path);
  else if (Array.isArray(value)) value.forEach((v, i) => numberLeaves(v, `${path}[${i}]`, found));
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) numberLeaves(v, `${path}.${k}`, found);
  }
  return found;
}

const deps = {
  resolveSession: (originTabId: string) => (originTabId === 'term-2' ? SESSION_2 : SESSION_1),
  sessionCwd: (sessionId: string) => (sessionId === SESSION_2 ? CWD_2 : CWD_1),
};

// ---------------------------------------------------------------------------
// Tab list (AC-3, AC-4)
// ---------------------------------------------------------------------------

test('두 탭에 각각 SET_ROOT 를 보내면 root 가 갈라지고 서로 오염되지 않는다', async () => {
  const { openInNewTab, updateTabTree, restoreFileExplorerTabs } = await loadTabs();
  let tabs = restoreFileExplorerTabs(null, deps);
  tabs = openInNewTab(tabs, { sessionId: SESSION_1, path: CWD_1 });
  tabs = openInNewTab(tabs, { sessionId: SESSION_1, path: CWD_1 });
  assert.equal(tabs.tabs.length, 2);
  const [first, second] = tabs.tabs;

  const afterFirst = updateTabTree(tabs, first.id, { type: 'SET_ROOT', path: DOCS });
  const afterBoth = updateTabTree(afterFirst, second.id, { type: 'SET_ROOT', path: SRC });

  const roots = afterBoth.tabs.map((t) => t.tree.root);
  assert.deepEqual(roots, [DOCS, SRC], '각 탭이 자기 SET_ROOT 만 반영해야 한다');
  // The first update must not have leaked into the second tab, and the input
  // state must not have been mutated in place.
  assert.equal(afterFirst.tabs[1].tree.root, CWD_1, '첫 탭의 SET_ROOT 가 둘째 탭으로 샜다');
  assert.equal(tabs.tabs[0].tree.root, CWD_1, 'updateTabTree 가 입력 상태를 제자리에서 바꿨다');
  assert.notEqual(afterBoth.tabs[0].tree, afterBoth.tabs[1].tree, '두 탭이 트리 인스턴스를 공유한다');
});

test('openInNewTab(tabs, {sessionId, path}) 가 root===path 인 탭을 더하고 활성화한다', async () => {
  const { openInNewTab, restoreFileExplorerTabs } = await loadTabs();
  const empty = restoreFileExplorerTabs(null, deps);
  const one = openInNewTab(empty, { sessionId: SESSION_1, path: CWD_1 });
  const two = openInNewTab(one, { sessionId: SESSION_2, path: DOCS });

  assert.equal(two.tabs.length, 2);
  const added = two.tabs[1];
  assert.equal(added.tree.root, DOCS);
  assert.equal(added.sessionId, SESSION_2);
  assert.equal(two.activeTabId, added.id, '새 탭이 활성화되지 않았다');
  assert.equal(typeof added.id, 'string');
  assert.notEqual(added.id, '');
  assert.notEqual(added.id, two.tabs[0].id, '새 탭 id 가 기존 탭과 겹친다');
  // Adding must leave the existing tab and the input state as they were.
  assert.equal(one.tabs.length, 1, 'openInNewTab 이 입력 상태를 제자리에서 바꿨다');
  assert.equal(two.tabs[0], one.tabs[0], '기존 탭 객체가 교체되었다');
});

// ---------------------------------------------------------------------------
// Per-tab persistence (AC-6, AC-7, AC-8, FR-FEX-002 AC-7)
// ---------------------------------------------------------------------------

test('MemoryStorage: 워크스페이스별 탭 목록(순서·안정 id·root·mode·sort·scrollAnchor) 저장/복원 왕복, 두 탭 값이 독립', async () => {
  const { saveFileExplorerStateForWorkspace, readPersistedFileExplorerState, getFileExplorerStateStorageKey } =
    await loadStore();
  const storage = new MemoryStorage();

  assert.equal(getFileExplorerStateStorageKey(WS_A), EXPLORER_KEY_PREFIX + WS_A);

  const tabA1 = { id: 'fx-1', originTabId: 'term-1', root: DOCS, mode: 'list' as const, sort: BY_SIZE_DESC, scrollAnchor: 'report.md' };
  const tabA2 = { id: 'fx-2', originTabId: 'term-2', root: SRC, mode: 'tree' as const, sort: null, scrollAnchor: null };
  const tabB1 = { id: 'fx-9', originTabId: 'term-1', root: CWD_2, mode: 'list' as const, sort: BY_NAME_ASC, scrollAnchor: 'z.txt' };

  assert.equal(saveFileExplorerStateForWorkspace(WS_A, { tabs: [tabA1, tabA2], activeTabId: 'fx-2' }, storage), true);
  assert.equal(saveFileExplorerStateForWorkspace(WS_B, { tabs: [tabB1], activeTabId: 'fx-9' }, storage), true);

  const a = readPersistedFileExplorerState(WS_A, storage);
  const b = readPersistedFileExplorerState(WS_B, storage);
  assert.notEqual(a, null);
  assert.notEqual(b, null);
  assert.deepEqual(a!.tabs, [tabA1, tabA2], '순서와 여섯 필드가 그대로 돌아와야 한다');
  assert.equal(a!.activeTabId, 'fx-2');
  assert.deepEqual(b!.tabs, [tabB1], '워크스페이스 B 가 A 의 값에 섞였다');
  assert.equal(typeof a!.savedAt, 'string');
  assert.deepEqual(Object.keys(JSON.parse(rawStored(storage, WS_A))).sort(), ENVELOPE_FIELDS);

  // Two tabs keep their own mode and sort: a list tab sorted by size next to a
  // tree tab with no sort is the normal case this requirement is for.
  assert.notEqual(a!.tabs[0].mode, a!.tabs[1].mode);
  assert.notDeepEqual(a!.tabs[0].sort, a!.tabs[1].sort);
});

test('같은 워크스페이스로 새 컨트롤러를 만들면(새로고침 모사) 저장된 탭들이 mode·sort·anchor 와 함께 같은 순서·id 로 복원된다', async () => {
  const { saveFileExplorerStateForWorkspace, readPersistedFileExplorerState } = await loadStore();
  const { restoreFileExplorerTabs } = await loadTabs();
  const storage = new MemoryStorage();

  const records = [
    { id: 'fx-7', originTabId: 'term-2', root: SRC, mode: 'tree' as const, sort: null, scrollAnchor: 'index.ts' },
    { id: 'fx-3', originTabId: 'term-1', root: DOCS, mode: 'list' as const, sort: BY_NAME_DESC, scrollAnchor: 'b.md' },
  ];
  saveFileExplorerStateForWorkspace(WS_A, { tabs: records, activeTabId: 'fx-3' }, storage);

  // The reload: nothing survives but the storage.
  const restored = restoreFileExplorerTabs(readPersistedFileExplorerState(WS_A, storage), deps);

  assert.deepEqual(restored.tabs.map((t) => t.id), ['fx-7', 'fx-3'], '순서나 id 가 바뀌었다 — id 는 새로고침 뒤에도 같아야 한다');
  assert.deepEqual(restored.tabs.map((t) => t.tree.root), [SRC, DOCS]);
  assert.deepEqual(restored.tabs.map((t) => t.tree.mode), ['tree', 'list']);
  assert.deepEqual(restored.tabs.map((t) => t.sort), [null, BY_NAME_DESC]);
  assert.deepEqual(restored.tabs.map((t) => t.scrollAnchor), ['index.ts', 'b.md']);
  assert.deepEqual(restored.tabs.map((t) => t.originTabId), ['term-2', 'term-1']);
  assert.deepEqual(restored.tabs.map((t) => t.sessionId), [SESSION_2, SESSION_1], '세션은 originTabId 로 다시 묶여야 한다');
  assert.equal(restored.activeTabId, 'fx-3');
});

test('복원된 탭의 root 조회가 실패하거나 root 가 비정상이면 세션 cwd 로 대체하고 오류를 내지 않는다(사용자 탐색 실패는 SEC-FOP-001 AC-5 대로 root 유지)', async () => {
  const { restoreFileExplorerTabs, resolveRestoredRootFailure } = await loadTabs();

  // A hand-edited or half-written value: the root is empty. The tab survives,
  // pointed at its session's cwd, with no error on screen.
  const restored = restoreFileExplorerTabs(
    {
      schemaVersion: 1,
      savedAt: '',
      activeTabId: 'fx-1',
      tabs: [
        { id: 'fx-1', originTabId: 'term-2', root: '', mode: 'list', sort: null, scrollAnchor: null },
        { id: 'fx-2', originTabId: 'term-1', root: '   ', mode: 'tree', sort: null, scrollAnchor: null },
      ],
    },
    deps,
  );
  assert.deepEqual(restored.tabs.map((t) => t.tree.root), [CWD_2, CWD_1]);
  assert.deepEqual(restored.tabs.map((t) => t.tree.error), [null, null]);
  assert.deepEqual(restored.tabs.map((t) => t.id), ['fx-1', 'fx-2'], '비정상 root 때문에 탭을 버리면 안 된다');

  // A stored root that no longer lists (deleted while the page was closed) is
  // not the user's mistake, so it falls back quietly. A root the user just
  // navigated to is: the root stays and the error is shown (SEC-FOP-001 AC-5).
  assert.equal(resolveRestoredRootFailure({ origin: 'restore' }), 'fallback-to-session-cwd');
  assert.equal(resolveRestoredRootFailure({ origin: 'navigate' }), 'keep-root-with-error');
});

test("저장 JSON 에 'expandedPaths' 부분문자열이 없고 복원 객체에도 키가 없다", async () => {
  const { saveFileExplorerStateForWorkspace, readPersistedFileExplorerState } = await loadStore();
  const { restoreFileExplorerTabs } = await loadTabs();
  const storage = new MemoryStorage();

  const live = liveTabRecord();
  saveFileExplorerStateForWorkspace(WS_A, { tabs: [live], activeTabId: live.id }, storage);

  const raw = rawStored(storage, WS_A);
  assert.equal(raw.includes('expandedPaths'), false, '펼친 디렉터리가 저장되었다');
  assert.equal(raw.includes('drafts'), false, '펼친 디렉터리의 경로가 다른 이름으로 저장되었다');

  const read = readPersistedFileExplorerState(WS_A, storage);
  assert.notEqual(read, null);
  assert.equal(Object.hasOwn(read!.tabs[0], 'expandedPaths'), false);

  // A hand-edited value that carries expandedPaths must not smuggle it back in.
  storage.setItem(
    EXPLORER_KEY_PREFIX + WS_B,
    JSON.stringify({
      schemaVersion: 1,
      savedAt: MODIFIED,
      activeTabId: 'fx-1',
      tabs: [{ id: 'fx-1', originTabId: 'term-1', root: DOCS, mode: 'tree', sort: null, scrollAnchor: null, expandedPaths: [SRC] }],
    }),
  );
  const handEdited = readPersistedFileExplorerState(WS_B, storage);
  assert.notEqual(handEdited, null);
  assert.equal(Object.hasOwn(handEdited!.tabs[0], 'expandedPaths'), false, '손으로 넣은 expandedPaths 가 읽기를 통과했다');
  const restored = restoreFileExplorerTabs(handEdited, deps);
  assert.equal(restored.tabs[0].tree.expandedPaths.size, 0, '복원된 트리에 펼친 디렉터리가 되살아났다');
});

test('scrollAnchor 는 문자열로 저장되고 숫자 필드(scrollTop 류)가 스키마에 없다', async () => {
  const { saveFileExplorerStateForWorkspace } = await loadStore();
  const storage = new MemoryStorage();

  const live = liveTabRecord();
  saveFileExplorerStateForWorkspace(WS_A, { tabs: [live], activeTabId: live.id }, storage);

  const [tab] = storedTabs(storage, WS_A);
  assert.deepEqual(Object.keys(tab).sort(), TAB_RECORD_FIELDS, '저장된 탭 필드가 허용 목록과 다르다');
  assert.equal(tab.scrollAnchor, 'report.md');
  assert.equal(typeof tab.scrollAnchor, 'string');
  assert.equal(rawStored(storage, WS_A).includes('48213'), false, '픽셀 오프셋이 저장되었다');
  // No number anywhere in a stored tab: a pixel offset under any name would
  // show up here, and nothing else in the record is numeric.
  assert.deepEqual(numberLeaves(tab), [], '저장된 탭에 숫자 필드가 있다');
});

test("저장값이 없거나 깨졌으면 기본 mode 'tree' 로 복원", async () => {
  const { readPersistedFileExplorerState } = await loadStore();
  const { restoreFileExplorerTabs, openInNewTab } = await loadTabs();
  const storage = new MemoryStorage();

  // Nothing stored, unparsable, wrong version, wrong wrapper: all null, never a throw.
  assert.equal(readPersistedFileExplorerState(WS_A, storage), null);
  storage.setItem(EXPLORER_KEY_PREFIX + WS_A, '{"schemaVersion":1,"tabs":[');
  assert.equal(readPersistedFileExplorerState(WS_A, storage), null);
  storage.setItem(EXPLORER_KEY_PREFIX + WS_A, JSON.stringify({ schemaVersion: 99, savedAt: '', activeTabId: null, tabs: [] }));
  assert.equal(readPersistedFileExplorerState(WS_A, storage), null);
  storage.setItem(EXPLORER_KEY_PREFIX + WS_A, JSON.stringify([{ id: 'fx-1' }]));
  assert.equal(readPersistedFileExplorerState(WS_A, storage), null);

  // With nothing restorable, the first tab the user opens is a tree.
  const fresh = openInNewTab(restoreFileExplorerTabs(null, deps), { sessionId: SESSION_1, path: CWD_1 });
  assert.equal(fresh.tabs[0].tree.mode, 'tree');

  // A tab whose stored mode is not one of the two falls back to tree instead of
  // being dropped or carried through as an unknown mode.
  storage.setItem(
    EXPLORER_KEY_PREFIX + WS_B,
    JSON.stringify({
      schemaVersion: 1,
      savedAt: MODIFIED,
      activeTabId: 'fx-1',
      tabs: [{ id: 'fx-1', originTabId: 'term-1', root: DOCS, mode: 'grid', sort: null, scrollAnchor: null }],
    }),
  );
  const restored = restoreFileExplorerTabs(readPersistedFileExplorerState(WS_B, storage), deps);
  assert.equal(restored.tabs.length, 1, '모드가 깨진 탭이 버려졌다');
  assert.equal(restored.tabs[0].tree.mode, 'tree');
});

test('탐색기 저장은 편집기 window_state_ 키와 PersistedWindowState 를 건드리지 않고 file_explorer_state_ 별도 키에만 쓴다', async () => {
  const store = await loadStore();
  const storage = new MemoryStorage();

  const editorWindows = [{ tabId: 'term-1', filePath: 'C:/work/notes/one.md' }];
  assert.equal(store.saveWindowStateForWorkspace(WS_A, editorWindows, storage), true);
  const editorRawBefore = storage.getItem(EDITOR_KEY_PREFIX + WS_A);
  const editorBefore = store.readPersistedWindowState(WS_A, storage);

  store.saveFileExplorerStateForWorkspace(
    WS_A,
    { tabs: [{ id: 'fx-1', originTabId: 'term-1', root: DOCS, mode: 'tree', sort: null, scrollAnchor: null }], activeTabId: 'fx-1' },
    storage,
  );

  assert.deepEqual(storage.keys(), [EXPLORER_KEY_PREFIX + WS_A, EDITOR_KEY_PREFIX + WS_A].sort());
  assert.equal(storage.getItem(EDITOR_KEY_PREFIX + WS_A), editorRawBefore, '탐색기 저장이 편집기 값을 바꿨다');
  assert.deepEqual(store.readPersistedWindowState(WS_A, storage), editorBefore);
  assert.notEqual(store.getFileExplorerStateStorageKey(WS_A), store.getWindowStateStorageKey(WS_A));
  // Each reader answers only its own key: the explorer value is not an editor
  // value and the other way round.
  assert.equal(store.readPersistedWindowState(WS_B, storage), null);
  storage.removeItem(EXPLORER_KEY_PREFIX + WS_A);
  assert.equal(store.readPersistedFileExplorerState(WS_A, storage), null, '탐색기 읽기가 편집기 키를 읽었다');
});

// ---------------------------------------------------------------------------
// Scroll restore by anchor (AC-8~AC-11)
// ---------------------------------------------------------------------------

test('decideScrollRestore: rowCount 0 이면 앵커와 무관하게 wait', async () => {
  const { decideScrollRestore } = await loadScroll();
  const rows = [file('a.txt'), file('b.txt')];

  // rowCount is what is observed in the list; the listing may already be in
  // state while nothing is painted yet. Writing a scroll now would be clamped to
  // 0 by the browser without an error.
  assert.deepEqual(decideScrollRestore({ rowCount: 0, anchorName: 'b.txt', visibleRows: rows, sort: BY_NAME_ASC }), { kind: 'wait' });
  assert.deepEqual(decideScrollRestore({ rowCount: 0, anchorName: 'gone.txt', visibleRows: rows, sort: BY_NAME_ASC }), { kind: 'wait' });
  assert.deepEqual(decideScrollRestore({ rowCount: 0, anchorName: null, visibleRows: [], sort: null }), { kind: 'wait' });

  // Once rows are observed, a present anchor is scrolled to.
  const found = decideScrollRestore({ rowCount: 2, anchorName: 'b.txt', visibleRows: rows, sort: BY_NAME_ASC });
  assert.equal(found.kind, 'scroll');
  assert.equal(found.kind === 'scroll' && found.name, 'b.txt');
});

test('앵커 미발견 복원 결과는 shouldPersist:false, 저장 함수는 shouldPersist 일 때만 호출', async () => {
  const { decideScrollRestore } = await loadScroll();
  const { saveFileExplorerStateForWorkspace, readPersistedFileExplorerState } = await loadStore();
  const storage = new MemoryStorage();

  const record = { id: 'fx-1', originTabId: 'term-1', root: DOCS, mode: 'list' as const, sort: BY_NAME_ASC, scrollAnchor: 'd.txt' };
  saveFileExplorerStateForWorkspace(WS_A, { tabs: [record], activeTabId: 'fx-1' }, storage);

  // The anchor is not among the rows: deleted, or simply not painted yet. The
  // fallback scroll is fine; writing the fallback back is not (STA-5949).
  const rows = [file('a.txt'), file('c.txt'), file('e.txt')];
  const result = decideScrollRestore({ rowCount: rows.length, anchorName: 'd.txt', visibleRows: rows, sort: BY_NAME_ASC });
  assert.equal(result.kind, 'scroll');
  assert.equal(result.kind === 'scroll' && result.shouldPersist, false, '못 찾은 앵커의 대비책을 저장하려 한다');
  assert.equal(result.kind === 'scroll' && result.name, 'e.txt');

  // This module has no storage access; the flag is the whole contract here.
  // That the window's scroll handler writes only on shouldPersist is asserted
  // by the component's contract test (TC-REQ-FR-FEX-003-AC10-02), not here.
  // The stored value is read back only to show the setup the flag protects.
  assert.equal(readPersistedFileExplorerState(WS_A, storage)!.tabs[0].scrollAnchor, 'd.txt');

  // Same for the other fallback: rows exist but no nearest name can be told
  // apart (server order), so the restore goes to the first row — still unsaved.
  const unsorted = decideScrollRestore({ rowCount: rows.length, anchorName: 'd.txt', visibleRows: rows, sort: null });
  assert.equal(unsorted.kind, 'scroll');
  assert.equal(unsorted.kind === 'scroll' && unsorted.name, 'a.txt');
  assert.equal(unsorted.kind === 'scroll' && unsorted.shouldPersist, false);
});

test("decideAnchorPersist: restoreState 'pending' 이면 사용자 스크롤이어도 저장하지 않는다", async () => {
  const { decideAnchorPersist } = await loadScroll();
  // Until the restore has run, whatever row is on top is not what the user
  // chose; saving it would overwrite the anchor the restore is about to use.
  assert.equal(decideAnchorPersist({ restoreState: 'pending', userInitiated: true, rowCount: 12 }), 'skip');
  assert.equal(decideAnchorPersist({ restoreState: 'pending', userInitiated: false, rowCount: 12 }), 'skip');
  assert.equal(decideAnchorPersist({ restoreState: 'pending', userInitiated: true, rowCount: 0 }), 'skip');
});

test('decideAnchorPersist: 복원 대비책의 프로그램 스크롤(userInitiated:false)은 저장하지 않는다', async () => {
  const { decideAnchorPersist } = await loadScroll();
  // The fallback scrollIntoView fires a scroll event of its own. If that event
  // could save, a failed restore would write its fallback through the back door.
  assert.equal(decideAnchorPersist({ restoreState: 'failed', userInitiated: false, rowCount: 12 }), 'skip');
  assert.equal(decideAnchorPersist({ restoreState: 'done', userInitiated: false, rowCount: 12 }), 'skip');
});

test("decideAnchorPersist: 행이 있고 restoreState 'done'|'failed' 인 사용자 스크롤은 맨 위 행 이름을 저장한다", async () => {
  const { decideAnchorPersist } = await loadScroll();
  const { saveFileExplorerStateForWorkspace, readPersistedFileExplorerState } = await loadStore();

  assert.equal(decideAnchorPersist({ restoreState: 'done', userInitiated: true, rowCount: 12 }), 'save');
  // After a failed restore the user's own scroll is a real choice again and
  // must be remembered, or the stale anchor would be restored forever.
  assert.equal(decideAnchorPersist({ restoreState: 'failed', userInitiated: true, rowCount: 12 }), 'save');
  // No rows means no top row whose name could be saved.
  assert.equal(decideAnchorPersist({ restoreState: 'done', userInitiated: true, rowCount: 0 }), 'skip');

  // What is saved is the top row's name, and it comes back as that name.
  const storage = new MemoryStorage();
  const topRowName = 'notes-2026.md';
  saveFileExplorerStateForWorkspace(
    WS_A,
    { tabs: [{ id: 'fx-1', originTabId: 'term-1', root: DOCS, mode: 'list', sort: BY_NAME_ASC, scrollAnchor: topRowName }], activeTabId: 'fx-1' },
    storage,
  );
  assert.equal(readPersistedFileExplorerState(WS_A, storage)!.tabs[0].scrollAnchor, topRowName);
});

test('nearestName: 정렬 순서상 가장 가까운 이름, 없으면 첫 행, 행이 없으면 top', async () => {
  const { nearestName } = await loadScroll();
  const asc = [file('a.txt'), file('c.txt'), file('e.txt')];
  const desc = [file('e.txt'), file('c.txt'), file('a.txt')];

  // The row that now sits where the missing one would have been.
  assert.equal(nearestName(asc, 'd.txt', BY_NAME_ASC), 'e.txt');
  assert.equal(nearestName(asc, '0.txt', BY_NAME_ASC), 'a.txt');
  // Past the last row, the closest is the last row — not the first.
  assert.equal(nearestName(asc, 'z.txt', BY_NAME_ASC), 'e.txt');
  // The direction is the view's: in descending order the next row after 'd' is 'c'.
  assert.equal(nearestName(desc, 'd.txt', BY_NAME_DESC), 'c.txt');

  // Only the name was saved, so an order that is not by name (server order,
  // or by size/date) cannot place the missing row: first row.
  assert.equal(nearestName(asc, 'd.txt', null), 'a.txt');
  assert.equal(nearestName([file('big.bin', 900), file('mid.bin', 50)], 'gone.bin', BY_SIZE_DESC), 'big.bin');

  // No rows at all: top.
  assert.equal(nearestName([], 'd.txt', BY_NAME_ASC), null);

  // The order has one definition. The restore reuses the list view's comparator
  // instead of carrying a second collation that could drift from what is drawn.
  const sourcePath = new URL(SCROLL_PATH, import.meta.url);
  assert.equal(existsSync(sourcePath), true);
  const code = readFileSync(sourcePath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.match(code, /import\s*\{[^}]*\bcompareListRows\b[^}]*\}\s*from\s*'\.\/fileListView\.ts'/);
  assert.equal(/localeCompare/.test(code), false, '복원 모듈이 자기 정렬 규칙을 따로 갖고 있다');
});

// ---------------------------------------------------------------------------
// FX3-008 — only a restored tab falls back when its first listing fails; a tab
// the user just opened keeps its root and shows the error (SEC-FOP-001 AC-5)
// ---------------------------------------------------------------------------

test('FX3-008 탭은 출처(restored/opened)를 갖고, 첫 조회 실패 대비책은 복원된 탭에만 적용된다', async () => {
  const { openInNewTab, restoreFileExplorerTabs, firstListingFailureAction } = await loadTabs();
  const restored = restoreFileExplorerTabs(
    {
      schemaVersion: 1,
      savedAt: '',
      activeTabId: 'fx-1',
      tabs: [{ id: 'fx-1', originTabId: 'term-2', root: SRC, mode: 'tree', sort: null, scrollAnchor: null }],
    },
    deps,
  );
  assert.equal(restored.tabs[0].origin, 'restored');
  assert.equal(firstListingFailureAction(restored.tabs[0]), 'fallback-to-session-cwd');

  const opened = openInNewTab(restored, { sessionId: SESSION_1, path: DOCS, originTabId: 'term-1' });
  const fresh = opened.tabs[opened.tabs.length - 1];
  assert.equal(fresh.origin, 'opened');
  assert.equal(firstListingFailureAction(fresh), 'keep-root-with-error', 'a brand-new tab silently jumped to the session cwd');
});

// ---------------------------------------------------------------------------
// FX3-010 — a deleted workspace takes its explorer window and stored tabs with it
// ---------------------------------------------------------------------------

test('FX3-010 사라진 워크스페이스의 창 기록은 빠지고 그 저장 키가 지워진다; 목록이 비면 아무것도 지우지 않는다', async () => {
  const { dropWindowsOfRemovedWorkspaces } = await loadTabs();
  const store = await loadStore();
  const windows = { [WS_A]: { tag: 'a' }, [WS_B]: { tag: 'b' } };

  const kept = dropWindowsOfRemovedWorkspaces(windows, [WS_A, WS_B]);
  assert.equal(kept.windows, windows, 'nothing removed must keep the same object (no re-render)');
  assert.deepEqual(kept.removed, []);

  const dropped = dropWindowsOfRemovedWorkspaces(windows, [WS_A]);
  assert.deepEqual(Object.keys(dropped.windows), [WS_A]);
  assert.deepEqual(dropped.removed, [WS_B]);

  // An empty list is a list not loaded yet, not "every workspace was deleted".
  const empty = dropWindowsOfRemovedWorkspaces(windows, []);
  assert.equal(empty.windows, windows);
  assert.deepEqual(empty.removed, []);

  const storage = new MemoryStorage();
  store.saveFileExplorerStateForWorkspace(WS_B, { tabs: [], activeTabId: null }, storage);
  store.saveFileExplorerStateForWorkspace(WS_A, { tabs: [], activeTabId: null }, storage);
  store.removeFileExplorerStateForWorkspace(WS_B, storage);
  assert.equal(storage.getItem(store.getFileExplorerStateStorageKey(WS_B)), null);
  assert.notEqual(storage.getItem(store.getFileExplorerStateStorageKey(WS_A)), null, "another workspace's key was removed");
});

/** @req FR-FEX-010 */
test('FR-FEX-010 AC-7 다른 세션에서 열면 그 세션의 cwd 탭을 새로 열고, 같은 세션·같은 뿌리의 탭이 있으면 그것을 활성화한다', async () => {
  const m = await import('../../src/components/fileExplorer/fileExplorerTabsState.ts') as typeof TabsModule;
  const empty = { tabs: [], activeTabId: null };
  const first = m.focusOrOpenSessionTab(empty, { sessionId: 's-home', path: 'C:\\Users\\beom', originTabId: 't-home' });
  assert.equal(first.tabs.length, 1);

  // A second terminal in another directory: the window must gain a tab rooted there.
  const second = m.focusOrOpenSessionTab(first, { sessionId: 's-b', path: 'B:\\', originTabId: 't-b' });
  assert.equal(second.tabs.length, 2, 'opening from another session adds a tab for that session');
  const bTab = second.tabs.find((tab) => tab.sessionId === 's-b');
  assert.ok(bTab);
  assert.equal(bTab.tree.root, 'B:\\');
  assert.equal(second.activeTabId, bTab.id, 'the new tab is the active one');

  // Back to the first terminal: its tab already exists, so it is activated, not duplicated.
  const again = m.focusOrOpenSessionTab(second, { sessionId: 's-home', path: 'C:\\Users\\beom\\', originTabId: 't-home' });
  assert.equal(again.tabs.length, 2, 'the same session and root does not open a second tab');
  assert.equal(again.activeTabId, first.activeTabId);

  // The same terminal after a cd: its current directory gets its own tab.
  const moved = m.focusOrOpenSessionTab(again, { sessionId: 's-home', path: 'C:\\work', originTabId: 't-home' });
  assert.equal(moved.tabs.length, 3);
  assert.equal(moved.tabs.find((tab) => tab.id === moved.activeTabId)?.tree.root, 'C:\\work');
});

/** @req FR-FEX-010 */
test('FR-FEX-010 AC-7 openFileExplorer 는 창을 새로 만들 때도, 이미 떠 있어 끌어올릴 때도 요청한 세션의 탭을 focusOrOpenSessionTab 으로 맞춘다', () => {
  const hook = readFileSync(new URL('../../src/hooks/useFileExplorerWindows.ts', import.meta.url), 'utf8');
  const body = hook.slice(hook.indexOf('const openFileExplorer = useCallback('), hook.indexOf('const closeFileExplorer = useCallback('));
  assert.ok(body.length > 0, 'openFileExplorer not found');
  const raise = body.slice(body.indexOf("if (decision.action === 'raise')"));
  const raiseEnd = raise.indexOf('return;');
  assert.match(raise.slice(0, raiseEnd), /focusOrOpenSessionTab\(/, 'raising an open window must bring the requesting session\'s tab forward');
  assert.match(body.slice(body.indexOf('const initial')), /focusOrOpenSessionTab\(/, 'a window restored from storage must still show the requesting session');
});

/** @req FR-FEX-003 (#120) */
test('#120 탐색기 탭 이름은 원래 터미널 탭 이름이고, 모르면 폴더 이름, 겹치면 이름 · 폴더', async () => {
  const m = await import('../../src/components/fileExplorer/fileExplorerPathBarModel.ts');
  assert.deepEqual(m.explorerTabLabels([
    { sessionTabName: 'server', root: 'C:\\work\\api' },
    { sessionTabName: 'docs', root: 'B:\\' },
  ]), ['server', 'docs'], 'each tab takes its terminal tab name');
  assert.deepEqual(m.explorerTabLabels([
    { sessionTabName: '', root: 'C:\\work\\api' },
    { sessionTabName: '   ', root: '/home/u/proj' },
  ]), ['api', 'proj'], 'no terminal name: the folder name, as before');
  assert.deepEqual(m.explorerTabLabels([
    { sessionTabName: 'server', root: 'C:\\work\\api' },
    { sessionTabName: 'server', root: 'C:\\work\\web' },
    { sessionTabName: 'docs', root: 'B:\\' },
  ]), ['server · api', 'server · web', 'docs'], 'the same terminal twice (after a cd) is told apart by folder');
});

/** @req FR-FEX-003 (#120) */
test('#120 탭 막대는 explorerTabLabels 로 이름을 그리고, 창은 원래 터미널 탭 이름을 넘긴다', () => {
  const bar = readFileSync(new URL('../../src/components/fileExplorer/FileExplorerTabBar.tsx', import.meta.url), 'utf8');
  assert.match(bar, /explorerTabLabels\(/, 'labels come from explorerTabLabels');
  assert.doesNotMatch(bar, /\{rootLabel\(root\)\}/, 'the folder name is no longer the label by itself');
  const hook = readFileSync(new URL('../../src/hooks/useFileExplorerWindows.ts', import.meta.url), 'utf8');
  assert.match(hook, /sessionTabName/, 'each tab view carries its terminal tab name');
  assert.match(hook, /'id' \| 'workspaceId' \| 'sessionId' \| 'cwd' \| 'name'/, 'the hook reads terminal tab names');
});
