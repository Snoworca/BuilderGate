import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import type * as FileTreeControllerModule from '../../src/components/fileExplorer/fileTreeController.ts';
import {
  canGoUp,
  createInitialFileTreeState,
  fileTreeReducer,
  selectVisibleRows,
  type FileTreeAction,
  type FileTreeMode,
  type FileTreeState,
} from '../../src/components/fileExplorer/fileTreeState.ts';
import type { DirectoryEntry, DirectoryListing } from '../../src/types/index.ts';

// FR-FEX-001 AC-1·AC-3·AC-5·AC-6 / CON-FEX-001 AC-6 / SEC-FOP-001 AC-4·AC-5 —
// the asynchronous half of useFileTree: when a listing is requested, and which
// arriving answer is allowed to change the state.
//
// The controller is driven with the real fileTreeReducer and a fake
// listDirectory whose promises the test settles by hand. That is the only way
// to put answers out of order on purpose, and out-of-order answers are exactly
// where a controller that works in the happy path still shows stale data.
//
// Loaded inside each test for the same reason as fileTreeState.test.ts: a static
// import of a missing module crashes the runner before any test is named.
const MODULE_PATH = '../../src/components/fileExplorer/fileTreeController.ts';
type M = typeof FileTreeControllerModule;
type Controller = ReturnType<M['createFileTreeController']>;

async function load(): Promise<M> {
  return await import(MODULE_PATH) as M;
}

const SESSION = 'sess-1';
const MODIFIED = '2026-09-01T00:00:00.000Z';
const UP_ENTRY: DirectoryEntry = { name: '..', type: 'directory', size: 0, modified: MODIFIED };

function dir(name: string): DirectoryEntry {
  return { name, type: 'directory', size: 0, modified: MODIFIED };
}

function file(name: string): DirectoryEntry {
  return { name, type: 'file', size: 1, modified: MODIFIED };
}

// '..' first and only for non-root directories, as FileService sends it.
function listing(path: string, entries: DirectoryEntry[], hasUp: boolean): DirectoryListing {
  const all = (hasUp ? [UP_ENTRY, ...entries] : entries).map((e) => Object.freeze({ ...e }));
  return Object.freeze({ cwd: path, path, entries: Object.freeze(all) as DirectoryEntry[], totalEntries: all.length });
}

const DRIVE = 'C:\\';
const WORK = 'C:\\work';
const OTHER = 'C:\\work\\other';
const NOTES = 'C:\\work\\notes.txt';
const ROOT = 'C:\\work\\repo';
const DOCS = 'C:\\work\\repo\\docs';
const SRC = 'C:\\work\\repo\\src';
const A_TXT = 'C:\\work\\repo\\a.txt';
const LIB = 'C:\\work\\repo\\src\\lib';
const D_X = 'D:\\x';
const D_XY = 'D:\\x\\y';

const L_DRIVE = listing(DRIVE, [dir('work')], false);
const L_WORK = listing(WORK, [dir('other'), dir('repo'), file('notes.txt')], true);
const L_OTHER = listing(OTHER, [file('x.txt')], true);
const L_ROOT = listing(ROOT, [dir('docs'), dir('src'), file('a.txt')], true);
const L_SRC = listing(SRC, [dir('lib'), file('index.ts')], true);
const L_SRC_V2 = listing(SRC, [dir('lib'), file('added.ts'), file('index.ts')], true);
const L_DOCS = listing(DOCS, [file('guide.md')], true);
const L_D_X = listing(D_X, [dir('y')], true);
const L_D_XY = listing(D_XY, [file('z.txt')], true);

const BLOCKED_MESSAGE = 'Access denied: path is blocked by policy';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface ListCall {
  sessionId: string;
  path: string | undefined;
  settled: boolean;
  resolve(value: DirectoryListing): void;
  reject(reason: unknown): void;
}

// A path present in `auto` answers on its own (after the current microtask); any
// other path stays pending until the test settles it. `auto` is mutable so a
// test can change what the next read of a directory returns.
function createLister(auto: Record<string, DirectoryListing>) {
  const calls: ListCall[] = [];
  const listDirectory = (sessionId: string, path?: string): Promise<DirectoryListing> =>
    new Promise<DirectoryListing>((resolve, reject) => {
      const call: ListCall = {
        sessionId,
        path,
        settled: false,
        resolve: (value) => { call.settled = true; resolve(value); },
        reject: (reason) => { call.settled = true; reject(reason); },
      };
      calls.push(call);
      if (path !== undefined && Object.hasOwn(auto, path)) {
        const answer = auto[path];
        queueMicrotask(() => call.resolve(answer));
      }
    });

  const pendingFor = (path: string): ListCall[] => calls.filter((c) => c.path === path && !c.settled);
  const countFor = (path: string): number => calls.filter((c) => c.path === path).length;
  return { calls, listDirectory, pendingFor, countFor };
}

function createStore(initial: FileTreeState) {
  let state = initial;
  return {
    getState: (): FileTreeState => state,
    dispatch: (action: FileTreeAction): void => { state = fileTreeReducer(state, action); },
  };
}

// setImmediate runs after every queued microtask, so chained awaits inside the
// controller have all run by the time this returns; three rounds cover a
// controller that hops through a macrotask of its own.
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((r) => setImmediate(r));
}

// Methods may return void or a promise. The outcome is read from the state, not
// from the promise, so a rejection is swallowed here rather than left unhandled.
function fire(result: unknown): void {
  Promise.resolve(result).catch(() => {});
}

interface Harness {
  ctl: Controller;
  store: ReturnType<typeof createStore>;
  lister: ReturnType<typeof createLister>;
  auto: Record<string, DirectoryListing>;
}

// setRoot on a root that is not cached yet is how the first listing is loaded.
async function boot(root: string, auto: Record<string, DirectoryListing>, mode: FileTreeMode = 'tree'): Promise<Harness> {
  const { createFileTreeController } = await load();
  const store = createStore(createInitialFileTreeState({ root, mode }));
  const lister = createLister(auto);
  const ctl = createFileTreeController({
    sessionId: SESSION,
    listDirectory: lister.listDirectory,
    getState: store.getState,
    dispatch: store.dispatch,
  });
  fire(ctl.setRoot(root));
  await flush();
  return { ctl, store, lister, auto };
}

function entryNames(state: FileTreeState, path: string): string[] | null {
  const child = state.childrenByPath.get(path);
  return child?.status === 'loaded' ? child.entries.map((e) => e.name) : null;
}

function visibleNodePaths(state: FileTreeState): Set<string> {
  return new Set(selectVisibleRows(state).flatMap((row) => (row.kind === 'node' ? [row.path] : [])));
}

function settleOnly(calls: ListCall[], label: string): ListCall {
  assert.equal(calls.length, 1, `${label}: expected exactly one pending request, got ${calls.length}`);
  return calls[0];
}

// ---------------------------------------------------------------------------
// Sidecar test cases
// ---------------------------------------------------------------------------

test('setMode 호출 전후 listDirectory 호출 수 0', async () => {
  const h = await boot(ROOT, { [ROOT]: L_ROOT, [SRC]: L_SRC });
  fire(h.ctl.expand(SRC));
  await flush();
  const before = h.lister.calls.length;
  assert.equal(before, 2, 'precondition: root and src were each listed once');

  fire(h.ctl.setMode('list'));
  await flush();
  // A no-op setMode would also keep the count; the mode itself must move.
  assert.equal(h.store.getState().mode, 'list');
  fire(h.ctl.setMode('tree'));
  await flush();
  assert.equal(h.store.getState().mode, 'tree');

  assert.equal(h.lister.calls.length, before, 'switching modes must not reach the server');
});

test('같은 디렉터리를 두 번 펼쳐도 listDirectory 1회, refresh(path) 는 1회 더', async () => {
  const h = await boot(ROOT, { [ROOT]: L_ROOT, [SRC]: L_SRC });

  fire(h.ctl.expand(SRC));
  await flush();
  fire(h.ctl.expand(SRC));
  await flush();
  assert.equal(h.lister.countFor(SRC), 1);
  assert.ok(h.store.getState().expandedPaths.has(SRC), 'expand is idempotent, not a toggle');

  // Collapsing and reopening is still not a reason to read again.
  fire(h.ctl.collapse(SRC));
  await flush();
  assert.equal(h.store.getState().expandedPaths.has(SRC), false);
  fire(h.ctl.expand(SRC));
  await flush();
  assert.equal(h.lister.countFor(SRC), 1);

  // refresh reads again, and what it read is what the state now holds.
  h.auto[SRC] = L_SRC_V2;
  fire(h.ctl.refresh(SRC));
  await flush();
  assert.equal(h.lister.countFor(SRC), 2);
  assert.deepEqual(entryNames(h.store.getState(), SRC), ['lib', 'added.ts', 'index.ts']);

  assert.ok(h.lister.calls.every((c) => c.sessionId === SESSION), 'every read carries the session id');
});

test('applyJobDone(affectedDirectories) 가 이미 로드된 영향 디렉터리만 다시 읽는다', async () => {
  const h = await boot(ROOT, { [ROOT]: L_ROOT, [SRC]: L_SRC, [DOCS]: L_DOCS });
  fire(h.ctl.expand(SRC));
  fire(h.ctl.expand(DOCS));
  await flush();
  const before = h.lister.calls.length;

  h.auto[SRC] = L_SRC_V2;
  // LIB and the outside directory were never loaded: nothing on screen can be
  // stale there, so reading them would be a request for nothing.
  fire(h.ctl.applyJobDone([SRC, LIB, 'C:\\elsewhere']));
  await flush();

  const after = h.lister.calls.slice(before).map((c) => c.path);
  assert.deepEqual(after, [SRC], 'only the loaded affected directory is read again');
  const state = h.store.getState();
  assert.deepEqual(entryNames(state, SRC), ['lib', 'added.ts', 'index.ts']);
  assert.deepEqual(entryNames(state, DOCS), ['guide.md'], 'unaffected directories keep their listing');
  assert.ok(state.expandedPaths.has(SRC) && state.expandedPaths.has(DOCS), 'expansion survives the re-read');
});

test('goUp 은 parentPathOf(root) 를 조회하고 성공 시에만 root 를 옮긴다', async () => {
  const h = await boot(ROOT, { [ROOT]: L_ROOT });
  fire(h.ctl.goUp());
  await flush();

  const call = settleOnly(h.lister.pendingFor(WORK), 'parent listing');
  assert.equal(call.sessionId, SESSION);
  // Not moved yet: the parent has not been listed.
  assert.equal(h.store.getState().root, ROOT);

  call.resolve(L_WORK);
  await flush();
  const state = h.store.getState();
  assert.equal(state.root, WORK);
  assert.equal(state.pendingRoot, null);
  assert.equal(state.error, null);
  assert.equal(state.rootHasParent, true, "the new root's own '..' decides the next '↑'");
  assert.deepEqual(entryNames(state, WORK), ['other', 'repo', 'notes.txt']);
});

test('부모 조회가 blocked path 오류로 거부되면 root 불변 + error 에 서버 메시지', async () => {
  const h = await boot(ROOT, { [ROOT]: L_ROOT });
  fire(h.ctl.goUp());
  await flush();

  settleOnly(h.lister.pendingFor(WORK), 'parent listing').reject(new Error(BLOCKED_MESSAGE));
  await flush();

  const state = h.store.getState();
  assert.equal(state.root, ROOT, 'a refused parent listing must not move the root');
  assert.equal(state.pendingRoot, null);
  assert.ok(state.error !== null && state.error.includes(BLOCKED_MESSAGE), `error shows the server message, got ${String(state.error)}`);
  // '↑' being enabled never promised that the parent is listable (SEC-FOP-001 AC-4/AC-5).
  assert.equal(canGoUp(state), true);
  assert.notEqual(state.childrenByPath.get(WORK)?.status, 'loaded');
});

test("뿌리 조회 응답의 '..' 가 rootHasParent 로만 들어가고 childrenByPath 에는 없다", async () => {
  const h = await boot(ROOT, { [ROOT]: L_ROOT, [SRC]: L_SRC });
  fire(h.ctl.expand(SRC));
  await flush();

  const state = h.store.getState();
  assert.equal(state.rootHasParent, true);
  assert.deepEqual(entryNames(state, ROOT), ['docs', 'src', 'a.txt']);
  // A child listing carries '..' too; it must neither become a node nor touch the root's flag.
  assert.deepEqual(entryNames(state, SRC), ['lib', 'index.ts']);
  for (const key of state.childrenByPath.keys()) {
    assert.ok(!/[\\/]\.\.$/.test(key) && key !== '..', `no cache key for '..': ${key}`);
  }
  const rows = selectVisibleRows(state);
  assert.deepEqual(rows[0], { kind: 'up' });
  assert.ok(rows.every((row) => row.kind === 'up' || row.name !== '..'));
});

// ---------------------------------------------------------------------------
// Out-of-order answers (PM decision, from the review of the reducer task)
// ---------------------------------------------------------------------------

test('늦게 도착한 옛 조회 응답은 버려지고 캐시는 마지막 요청의 목록을 유지한다', async () => {
  const h = await boot(ROOT, { [ROOT]: L_ROOT });

  // Request #1 (expand) is still out when #2 (refresh) goes; #2 answers first.
  fire(h.ctl.expand(SRC));
  await flush();
  fire(h.ctl.refresh(SRC));
  await flush();
  const pending = h.lister.pendingFor(SRC);
  assert.equal(pending.length, 2, 'refresh must read again even while a read is in flight');
  const [first, second] = pending;
  second.resolve(L_SRC_V2);
  await flush();
  first.resolve(L_SRC);
  await flush();
  assert.deepEqual(entryNames(h.store.getState(), SRC), ['lib', 'added.ts', 'index.ts'], 'the older answer must not overwrite the newer one');

  // Same race, but the old request fails late: the good listing must stay.
  fire(h.ctl.expand(DOCS));
  await flush();
  fire(h.ctl.refresh(DOCS));
  await flush();
  const [oldDocs, newDocs] = h.lister.pendingFor(DOCS);
  assert.ok(oldDocs && newDocs, 'two reads of docs are in flight');
  newDocs.resolve(L_DOCS);
  await flush();
  oldDocs.reject(new Error('stale failure'));
  await flush();
  assert.equal(h.store.getState().childrenByPath.get(DOCS)?.status, 'loaded');
});

test('applyJobDone 재조회 중 늦게 온 작업 전 응답이 새 목록을 덮지 않는다', async () => {
  const h = await boot(ROOT, { [ROOT]: L_ROOT, [SRC]: L_SRC });
  fire(h.ctl.expand(SRC));
  await flush();

  // A refresh that left before the job finished carries the pre-job listing.
  delete h.auto[SRC];
  fire(h.ctl.refresh(SRC));
  await flush();
  fire(h.ctl.applyJobDone([SRC]));
  await flush();
  const pending = h.lister.pendingFor(SRC);
  assert.equal(pending.length, 2, 'a directory with a read in flight is still re-read after a job');
  const [preJob, postJob] = pending;
  postJob.resolve(L_SRC_V2);
  await flush();
  preJob.resolve(L_SRC);
  await flush();
  assert.deepEqual(entryNames(h.store.getState(), SRC), ['lib', 'added.ts', 'index.ts']);
});

test('goUp 대기 중 setRoot 와 다음 goUp 이 끼면 늦게 온 첫 goUp 의 성공·실패는 무시된다', async () => {
  // (1) goUp, then setRoot while it is out; the goUp succeeds late.
  {
    const h = await boot(ROOT, { [ROOT]: L_ROOT, [OTHER]: L_OTHER });
    fire(h.ctl.goUp());
    await flush();
    const late = settleOnly(h.lister.pendingFor(WORK), 'first goUp');
    fire(h.ctl.setRoot(OTHER));
    await flush();
    assert.equal(h.store.getState().root, OTHER);
    late.resolve(L_WORK);
    await flush();
    assert.equal(h.store.getState().root, OTHER, 'the last intent (setRoot) wins over a late goUp');
    assert.equal(h.store.getState().error, null);
  }
  // (2) Same, but the late goUp fails: its error belongs to an abandoned intent.
  {
    const h = await boot(ROOT, { [ROOT]: L_ROOT, [OTHER]: L_OTHER });
    fire(h.ctl.goUp());
    await flush();
    const late = settleOnly(h.lister.pendingFor(WORK), 'first goUp');
    fire(h.ctl.setRoot(OTHER));
    await flush();
    late.reject(new Error(BLOCKED_MESSAGE));
    await flush();
    assert.equal(h.store.getState().root, OTHER);
    assert.equal(h.store.getState().error, null, 'a stale failure must not surface');
  }
  // (3) goUp, setRoot elsewhere, goUp again; the second goUp answers first.
  {
    const h = await boot(ROOT, { [ROOT]: L_ROOT, [D_XY]: L_D_XY });
    fire(h.ctl.goUp());
    await flush();
    const late = settleOnly(h.lister.pendingFor(WORK), 'first goUp');
    fire(h.ctl.setRoot(D_XY));
    await flush();
    fire(h.ctl.goUp());
    await flush();
    settleOnly(h.lister.pendingFor(D_X), 'second goUp').resolve(L_D_X);
    await flush();
    assert.equal(h.store.getState().root, D_X);
    late.resolve(L_WORK);
    await flush();
    assert.equal(h.store.getState().root, D_X, 'the first goUp answering last must not pull the root back');
    assert.equal(h.store.getState().pendingRoot, null);
  }
});

test('goUp 을 연달아 두 번 눌러도 뿌리는 한 단계만 올라간다', async () => {
  const h = await boot(ROOT, { [ROOT]: L_ROOT });
  fire(h.ctl.goUp());
  fire(h.ctl.goUp());
  await flush();

  // Whether the second press is merged or sent, answers arrive newest first.
  const pending = h.lister.pendingFor(WORK);
  assert.ok(pending.length >= 1 && pending.length <= 2, `one or two parent reads, got ${pending.length}`);
  for (const call of [...pending].reverse()) {
    call.resolve(L_WORK);
    await flush();
  }
  const state = h.store.getState();
  assert.equal(state.root, WORK);
  assert.equal(state.pendingRoot, null);
  assert.equal(state.error, null);
  // The grandparent's listability is unknown until WORK itself has been listed.
  assert.equal(h.lister.countFor(DRIVE), 0);
});

test("뿌리 키 정규화: 끝 구분자와 '/' 표기의 같은 경로는 캐시를 다시 쓰고 조회하지 않는다", async () => {
  // Windows spelling: '/' and a trailing separator name the same directory.
  {
    const h = await boot(ROOT, { [ROOT]: L_ROOT, [SRC]: L_SRC });
    fire(h.ctl.expand(SRC));
    await flush();
    const before = h.lister.calls.length;

    fire(h.ctl.setRoot('C:/work/repo/'));
    await flush();
    assert.equal(h.store.getState().root, ROOT);
    assert.equal(h.store.getState().rootHasParent, true, 'the cached listing still decides ↑');
    fire(h.ctl.setRoot('C:\\work\\repo\\'));
    await flush();
    assert.equal(h.store.getState().root, ROOT);

    fire(h.ctl.collapse(SRC));
    fire(h.ctl.expand('C:/work/repo/src/'));
    await flush();
    assert.equal(h.lister.calls.length, before, 'no read for a directory already cached under another spelling');
    assert.deepEqual([...h.store.getState().expandedPaths], [SRC]);

    h.auto[SRC] = L_SRC_V2;
    fire(h.ctl.applyJobDone(['C:/work/repo/src/']));
    await flush();
    assert.deepEqual(h.lister.calls.slice(before).map((c) => c.path), [SRC], 'the re-read uses the canonical key');
  }
  // POSIX spelling: only the trailing separator goes; '/' is never turned into '\'.
  {
    const home = '/home/u/repo';
    const h = await boot(home, { [home]: listing(home, [dir('src')], true), '/home/u/repo/src': listing('/home/u/repo/src', [], true) });
    const before = h.lister.calls.length;
    fire(h.ctl.setRoot('/home/u/repo/'));
    await flush();
    assert.equal(h.store.getState().root, home);
    assert.equal(h.lister.calls.length, before);
    fire(h.ctl.expand('/home/u/repo/src/'));
    await flush();
    assert.deepEqual(h.lister.calls.slice(before).map((c) => c.path), ['/home/u/repo/src']);
  }
});

test("드라이브 루트에서 goUp 은 canGoUp=false 이므로 요청을 만들지 않는다", async () => {
  for (const [root, raw] of [[DRIVE, L_DRIVE], ['/', listing('/', [dir('home')], false)]] as const) {
    const h = await boot(root, { [root]: raw });
    assert.equal(canGoUp(h.store.getState()), false, `precondition: no '..' at ${root}`);
    const before = h.lister.calls.length;
    fire(h.ctl.goUp());
    await flush();
    const state = h.store.getState();
    assert.equal(h.lister.calls.length, before, `goUp at ${root} must not send a request`);
    assert.equal(state.root, root);
    assert.equal(state.pendingRoot, null);
    assert.equal(state.error, null);
  }
});

test('뿌리가 바뀌면 보이지 않게 된 선택은 정리된다', async () => {
  const assertSelectionVisible = (state: FileTreeState, label: string): void => {
    const visible = visibleNodePaths(state);
    for (const path of state.selectedPaths) assert.ok(visible.has(path), `${label}: invisible path still selected: ${path}`);
    assert.ok(state.anchorPath === null || visible.has(state.anchorPath), `${label}: anchor points at an invisible path`);
  };

  const h = await boot(ROOT, { [ROOT]: L_ROOT, [WORK]: L_WORK, [OTHER]: L_OTHER });
  const order = [...visibleNodePaths(h.store.getState())];
  h.store.dispatch({ type: 'CLICK_ROW', path: A_TXT, mods: { ctrl: false, shift: false }, orderedPaths: order });
  h.store.dispatch({ type: 'CLICK_ROW', path: SRC, mods: { ctrl: true, shift: false }, orderedPaths: order });
  assert.equal(h.store.getState().selectedPaths.size, 2, 'precondition: two rows selected');

  fire(h.ctl.goUp());
  await flush();
  assert.equal(h.store.getState().root, WORK);
  assertSelectionVisible(h.store.getState(), 'after goUp');

  const workOrder = [...visibleNodePaths(h.store.getState())];
  h.store.dispatch({ type: 'CLICK_ROW', path: NOTES, mods: { ctrl: false, shift: false }, orderedPaths: workOrder });
  assert.equal(h.store.getState().selectedPaths.size, 1, 'precondition: one row selected');
  fire(h.ctl.setRoot(OTHER));
  await flush();
  assert.equal(h.store.getState().root, OTHER);
  assertSelectionVisible(h.store.getState(), 'after setRoot');
});

// ---------------------------------------------------------------------------
// Hook wiring — no DOM harness here, so the thin hook is held by its source.
// ---------------------------------------------------------------------------

const HOOK_URL = new URL('../../src/hooks/useFileTree.ts', import.meta.url);
const CONTROLLER_URL = new URL('../../src/components/fileExplorer/fileTreeController.ts', import.meta.url);

// Comments are stripped so that a sentence such as "unlike useFileBrowser" can
// neither trip nor satisfy the guard.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

test('주석 제거 후 소스: useFileTree 는 useReducer(fileTreeReducer)·createFileTreeController·fileApi.listDirectory 로 배선하고 useFileBrowser 를 참조하지 않으며, 컨트롤러는 react 를 import 하지 않는다', () => {
  assert.ok(existsSync(HOOK_URL), 'frontend/src/hooks/useFileTree.ts must exist');
  assert.ok(existsSync(CONTROLLER_URL), 'frontend/src/components/fileExplorer/fileTreeController.ts must exist');
  const hook = stripComments(readFileSync(HOOK_URL, 'utf8'));
  const controller = stripComments(readFileSync(CONTROLLER_URL, 'utf8'));

  assert.match(hook, /export\s+function\s+useFileTree\s*\(/);
  assert.match(hook, /useReducer\s*\(\s*fileTreeReducer\b/);
  assert.match(hook, /createFileTreeController\s*\(/);
  assert.match(hook, /fileApi\.listDirectory\b/);
  assert.doesNotMatch(hook, /useFileBrowser/, 'useFileTree is written new, not grown from useFileBrowser');
  // The decision of when to read lives in the controller; the hook must not
  // keep a second copy of the cache rule. (Wrapping fileApi.listDirectory in an
  // arrow is still injection, so a call expression is not forbidden here.)
  assert.doesNotMatch(hook, /shouldFetchChildren/, 'the cache rule has one home: the controller');

  assert.doesNotMatch(controller, /from\s+['"]react['"]/, 'the controller runs without React');
  assert.match(controller, /shouldFetchChildren/, 'whether to read is decided by shouldFetchChildren only');
});

// ---------------------------------------------------------------------------
// FX3-005 — a finished job and a confirmed delete take their paths out of the
// selection, so a second Delete or a copy cannot act on a path that is gone
// ---------------------------------------------------------------------------

test('FX3-005 applyJobDone 이 끝나면 사라진 경로가 선택에서 빠지고 남은 경로는 그대로 선택된다', async () => {
  const h = await boot(ROOT, { [ROOT]: L_ROOT });
  const order = [...visibleNodePaths(h.store.getState())];
  h.store.dispatch({ type: 'CLICK_ROW', path: A_TXT, mods: { ctrl: false, shift: false }, orderedPaths: order });
  h.store.dispatch({ type: 'CLICK_ROW', path: SRC, mods: { ctrl: true, shift: false }, orderedPaths: order });
  assert.deepEqual([...h.store.getState().selectedPaths].sort(), [A_TXT, SRC].sort(), 'precondition: two rows selected');

  // a.txt was deleted by the job; the refreshed listing no longer has it.
  h.auto[ROOT] = listing(ROOT, [dir('docs'), dir('src')], true);
  fire(h.ctl.applyJobDone([ROOT]));
  await flush();

  const state = h.store.getState();
  assert.equal(entryNames(state, ROOT)?.includes('a.txt'), false, 'precondition: the listing was refreshed');
  assert.deepEqual([...state.selectedPaths], [SRC], 'the deleted path stayed selected, or the surviving one was dropped');
  assert.ok(state.anchorPath === null || visibleNodePaths(state).has(state.anchorPath), 'the anchor points at a deleted path');
});

test('FX3-005 deselect 는 확인된 삭제의 원본을 즉시 선택에서 뺀다', async () => {
  const h = await boot(ROOT, { [ROOT]: L_ROOT });
  const order = [...visibleNodePaths(h.store.getState())];
  h.store.dispatch({ type: 'CLICK_ROW', path: A_TXT, mods: { ctrl: false, shift: false }, orderedPaths: order });
  h.store.dispatch({ type: 'CLICK_ROW', path: DOCS, mods: { ctrl: true, shift: false }, orderedPaths: order });
  h.ctl.deselect([A_TXT]);
  const state = h.store.getState();
  assert.deepEqual([...state.selectedPaths], [DOCS]);
  assert.equal(state.anchorPath, DOCS, 'an anchor that was not removed stays');
  h.ctl.deselect([DOCS]);
  assert.equal(h.store.getState().selectedPaths.size, 0);
  assert.equal(h.store.getState().anchorPath, null, 'a removed anchor must not survive');
});
