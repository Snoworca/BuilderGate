import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type * as ScrollRestoreModule from '../../src/components/fileExplorer/fileExplorerScrollRestore.ts';
import type * as TabsStateModule from '../../src/components/fileExplorer/fileExplorerTabsState.ts';
import type * as ShortcutsModule from '../../src/components/fileExplorer/fileExplorerShortcuts.ts';
import type * as ClientModule from '../../src/components/fileExplorer/fileJobClient.ts';
import type * as ClipboardModule from '../../src/components/fileExplorer/fileExplorerClipboard.ts';

// FX3R-001..006 — what the round-1 recheck of the explorer found. The pure
// decisions are exercised directly; the React glue that has no DOM harness is
// held by its source, with comments stripped so prose can neither trip nor
// satisfy a check.
//
// Modules are loaded inside each test so a missing export shows as one named
// failure rather than a crash before any test is listed.

type SR = typeof ScrollRestoreModule;
type TS = typeof TabsStateModule;
type SH = typeof ShortcutsModule;
type CL = typeof ClientModule;
type CB = typeof ClipboardModule;

const FX = '../../src/components/fileExplorer/';
const loadScroll = async (): Promise<SR> => await import(`${FX}fileExplorerScrollRestore.ts`) as SR;
const loadTabs = async (): Promise<TS> => await import(`${FX}fileExplorerTabsState.ts`) as TS;
const loadShortcuts = async (): Promise<SH> => await import(`${FX}fileExplorerShortcuts.ts`) as SH;
const loadClient = async (): Promise<CL> => await import(`${FX}fileJobClient.ts`) as CL;
async function loadClipboard(): Promise<CB> {
  const m = await import(`${FX}fileExplorerClipboard.ts`) as CB;
  m.clearFileExplorerClipboard();
  return m;
}

const SRC = new URL('../../src/', import.meta.url);

function source(rel: string): string {
  return readFileSync(new URL(rel, SRC), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}

function bracketBody(text: string, open: number): string {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (pairs[ch] !== undefined) stack.push(pairs[ch]);
    else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced bracket at ${open}`);
}

/** Every `hook(` call in `text`, with its argument text. */
function hookCalls(text: string, hook: string): string[] {
  return [...text.matchAll(new RegExp(`\\b${hook}\\s*\\(`, 'g'))]
    .map((m) => bracketBody(text, m.index + m[0].length - 1));
}

const WINDOW = 'components/fileExplorer/FileExplorerWindow.tsx';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve: (v: T) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// FX3R-001 — the anchor search on a panel with no layout
// ---------------------------------------------------------------------------

test('FX3R-001 pickAnchorRow: 위쪽 가장자리 이하의 마지막 1단계 행, 레이아웃이 없으면 null', async () => {
  const { pickAnchorRow } = await loadScroll();
  const rows = [{ name: 'a', top: 80 }, { name: 'b', top: 100 }, { name: 'c', top: 120 }, { name: 'd', top: 140 }];
  assert.equal(pickAnchorRow(100, rows, true), 'b', 'the row at the top edge is the anchor');
  assert.equal(pickAnchorRow(110, rows, true), 'b', 'a row cut by the top edge is still the anchor');
  assert.equal(pickAnchorRow(50, rows, true), 'a', 'with every row below the edge the first row is the anchor');
  assert.equal(pickAnchorRow(100, [], true), null);
  // display: none — every rect is 0, which without the guard names the last row.
  const collapsed = rows.map((row) => ({ ...row, top: 0 }));
  assert.equal(pickAnchorRow(0, collapsed, false), null, 'a panel with no layout must not name any row');
});

test('FX3R-001 pickAnchorRow 는 위쪽 가장자리를 넘은 첫 행에서 멈춘다 — 나머지 행 위치를 읽지 않는다', async () => {
  const { pickAnchorRow } = await loadScroll();
  let read = 0;
  function* rows() {
    for (const [name, top] of [['a', 0], ['b', 20], ['c', 40], ['d', 60]] as const) {
      read += 1;
      yield { name, top };
    }
  }
  assert.equal(pickAnchorRow(20, rows(), true), 'b');
  assert.equal(read, 3, 'rows past the first one below the edge were read');
  read = 0;
  assert.equal(pickAnchorRow(20, rows(), false), null);
  assert.equal(read, 0, 'with no layout no row position is read');
});

test('FX3R-001 창: 기준 행 탐색은 pickAnchorRow 와 getClientRects 레이아웃 검사를 거치고, 숨겨질 때 대기 중 저장을 동기로 비운다', () => {
  const win = source(WINDOW);
  const commit = /const\s+commitPendingAnchor\s*=\s*useCallback\s*\(/.exec(win);
  assert.ok(commit, 'commitPendingAnchor = useCallback(...) not found');
  const body = bracketBody(win, commit.index + commit[0].length - 1);
  assert.match(body, /\bpickAnchorRow\s*\(/, 'the search must go through pickAnchorRow');
  assert.match(body, /\.getClientRects\s*\(\s*\)\s*\.length/, 'the commit must check that the container has layout');

  // A layout effect keyed on active and hidden that flushes the pending commit.
  const flush = hookCalls(win, 'useLayoutEffect').find((args) => {
    const deps = /\[([^\]]*)\]\s*$/.exec(args.trim());
    return deps !== null && /\bactive\b/.test(deps[1]) && /\bhidden\b/.test(deps[1]) && /\bcommitPendingAnchor\s*\(/.test(args);
  });
  assert.ok(flush, 'no useLayoutEffect([active, hidden, ...]) flushes commitPendingAnchor when the panel hides');
  assert.match(flush, /\bclearTimeout\s*\(/, 'the flush must cancel the timer it replaces');

  // A tab switch hides the panel through its own className before any effect
  // runs, so the window asks the panel on screen to commit first.
  const tabBar = /<FileExplorerTabBar\b/.exec(win);
  assert.ok(tabBar);
  const onSelect = /\sonSelect\s*=\s*\{/.exec(win.slice(tabBar.index));
  assert.ok(onSelect, '<FileExplorerTabBar> has no onSelect');
  const at = tabBar.index + onSelect.index + onSelect[0].length - 1;
  const onSelectBody = bracketBody(win, at);
  const flushCall = /\b(\w*[Ff]lush\w*)\s*\(/.exec(onSelectBody);
  assert.ok(flushCall, 'selecting a tab must flush the active panel anchor first');
  assert.ok(onSelectBody.indexOf(flushCall[0]) < onSelectBody.search(/\bselectTab\s*\(/), 'the flush must come before selectTab');
  const decl = new RegExp(`const\\s+${flushCall[1]}\\s*=`).exec(win);
  assert.ok(decl, `${flushCall[1]} is not declared`);
  const declBody = bracketBody(win, win.indexOf('{', win.indexOf('=>', decl.index)));
  assert.match(declBody, /\.flushAnchor\s*\(\s*\)/, `${flushCall[1]} must call the active panel's flushAnchor()`);
});

// ---------------------------------------------------------------------------
// FX3R-002 — a deleted workspace without a window record
// ---------------------------------------------------------------------------

test('FX3R-002 removedWorkspaceIds: 사라진 id 만, 빈 목록은 "아직 안 불러옴"', async () => {
  const { removedWorkspaceIds } = await loadTabs();
  assert.deepEqual(removedWorkspaceIds(['w1', 'w2', 'w3'], ['w1', 'w3']), ['w2']);
  assert.deepEqual(removedWorkspaceIds([], ['w1']), [], 'the first load removes nothing');
  assert.deepEqual(removedWorkspaceIds(['w1', 'w2'], []), [], 'an empty list means not loaded — the server never deletes the last workspace');
  assert.deepEqual(removedWorkspaceIds(['w1'], ['w1', 'w2']), []);
});

test('FX3R-002 훅: 이전 워크스페이스 id 목록을 ref 로 들고, 사라진 id 의 저장 키를 창 기록 유무와 무관하게 지운다', () => {
  const hook = source('hooks/useFileExplorerWindows.ts');
  assert.match(hook, /\bremovedWorkspaceIds\s*\(/, 'the hook must diff the workspace list with removedWorkspaceIds');
  const effect = hookCalls(hook, 'useEffect').find((args) => /\bremovedWorkspaceIds\s*\(/.test(args));
  assert.ok(effect, 'removedWorkspaceIds must run inside an effect');
  assert.match(effect, /\bremoveFileExplorerStateForWorkspace\s*\(/, 'the effect must clear the storage keys');
});

// ---------------------------------------------------------------------------
// FX3R-003 — a rejected delete keeps the selection
// ---------------------------------------------------------------------------

test('FX3R-003 requestDelete: onAccepted 는 서버가 받은 뒤에만, 거절·취소면 부르지 않는다', async () => {
  const client = await loadClient();
  const selection = { sessionId: 's-1', paths: ['/work/a.txt', '/work/..', '/work/b.txt'] };
  const confirm = async () => 'confirm' as const;

  const accepted: string[][] = [];
  const onAccepted = (paths: readonly string[]) => { accepted.push([...paths]); };

  const post = deferred<{ jobId: string }>();
  const pending = client.requestDelete({ client: { submit: () => post.promise }, confirm, selection, onAccepted });
  await Promise.resolve();
  assert.deepEqual(accepted, [], 'the selection left before the server answered');
  post.resolve({ jobId: 'job-1' });
  assert.deepEqual(await pending, { jobId: 'job-1' });
  assert.deepEqual(accepted, [['/work/a.txt', '/work/b.txt']], 'onAccepted gets the submitted sources');

  accepted.length = 0;
  await assert.rejects(client.requestDelete({
    client: { submit: async () => { throw new Error('HTTP 403'); } }, confirm, selection, onAccepted,
  }));
  assert.deepEqual(accepted, [], 'a rejected POST dropped the selection');

  await client.requestDelete({ client: { submit: async () => ({ jobId: 'x' }) }, confirm: async () => 'cancel', selection, onAccepted });
  assert.deepEqual(accepted, []);
});

test('FX3R-003 패널: 확인 즉시 선택을 풀지 않는다 — requestDelete 의 onAccepted 로 deselect 한다', () => {
  const win = source(WINDOW);
  assert.doesNotMatch(win, /\bconfirmAndDeselect\b/, 'deselecting on confirm loses the selection when the POST is refused');
  const call = hookCalls(win, 'requestDelete');
  assert.ok(call.length >= 1, 'the panel no longer calls requestDelete');
  for (const args of call) assert.match(args, /\bonAccepted\s*:\s*deselect\b/, 'requestDelete must deselect through onAccepted');
});

// ---------------------------------------------------------------------------
// FX3R-004 — a stale text selection must not disable file copy
// ---------------------------------------------------------------------------

interface FakeNode { nodeType: number; parentElement: FakeElement | null }
interface FakeElement extends FakeNode { classes: string[]; closest: (s: string) => unknown }

// Enough of Element.closest for class selectors joined by commas.
function element(classes: string[], parent: FakeElement | null = null): FakeElement {
  const el: FakeElement = {
    nodeType: 1,
    parentElement: parent,
    classes,
    closest(selector: string) {
      const wanted = selector.split(',').map((s) => s.trim().replace(/^\./, ''));
      for (let cur: FakeElement | null = el; cur !== null; cur = cur.parentElement) {
        if (cur.classes.some((c) => wanted.includes(c))) return cur;
      }
      return null;
    },
  };
  return el;
}

function textIn(parent: FakeElement): FakeNode {
  return { nodeType: 3, parentElement: parent };
}

test('FX3R-004 isExplorerTextSelection: 경로 막대·확인 줄 안의 텍스트만 센다', async () => {
  const { isExplorerTextSelection, decideFileExplorerShortcut } = await loadShortcuts();
  const body = element(['fx-window-body']);
  const pathBar = element(['fx-pathbar-wrap'], body);
  const confirm = element(['fx-confirm-bar'], body);
  const row = element(['fx-row'], element(['fx-scroll'], body));
  const inBody = new Set<unknown>([body, pathBar, confirm, row]);
  const surface = { contains: (node: unknown) => node !== null && (inBody.has(node) || inBody.has((node as FakeNode).parentElement)) };

  assert.equal(isExplorerTextSelection({ isCollapsed: false, focusNode: textIn(pathBar) }, surface), true);
  assert.equal(isExplorerTextSelection({ isCollapsed: false, focusNode: textIn(confirm) }, surface), true);
  assert.equal(isExplorerTextSelection({ isCollapsed: false, focusNode: textIn(row) }, surface), false, 'text left selected on a row disabled file copy');
  assert.equal(isExplorerTextSelection({ isCollapsed: true, focusNode: textIn(pathBar) }, surface), false);
  assert.equal(isExplorerTextSelection({ isCollapsed: false, focusNode: textIn(element(['fx-pathbar-wrap'])) }, surface), false, 'outside the window');
  assert.equal(isExplorerTextSelection(null, surface), false);

  const rowText = isExplorerTextSelection({ isCollapsed: false, focusNode: textIn(row) }, surface);
  const ctrlC = { key: 'c', ctrlKey: true, metaKey: false };
  assert.equal(decideFileExplorerShortcut({ event: ctrlC, focusedInSurface: true, selectionCount: 1, hasTextSelection: rowText }).kind, 'copy');
});

test('FX3R-004 창: 단축키 문맥은 isExplorerTextSelection 을 쓰고, 행 영역 pointerdown 이 문서 선택을 접는다', () => {
  const win = source(WINDOW);
  assert.match(win, /\bhasTextSelection\s*:\s*isExplorerTextSelection\s*\(/, 'the shortcut context must decide text selection with isExplorerTextSelection');
  const scroll = /className="fx-scroll"/.exec(win);
  assert.ok(scroll);
  const tagEnd = win.indexOf('>', scroll.index);
  const pointer = /\sonPointerDown\s*=\s*\{\s*(\w+)\s*\}/.exec(win.slice(scroll.index, tagEnd));
  assert.ok(pointer, 'the rows container has no onPointerDown');
  const decl = new RegExp(`const\\s+${pointer[1]}\\s*=`).exec(win);
  assert.ok(decl, `${pointer[1]} is not declared`);
  const arrow = win.indexOf('{', win.indexOf('=>', decl.index));
  assert.match(bracketBody(win, arrow), /getSelection\s*\(\s*\)\s*\?\.\s*removeAllRanges\s*\(/, `${pointer[1]} must collapse the document selection`);
});

// ---------------------------------------------------------------------------
// FX3R-005 — paste single-flight is global, keyed on the clipboard value
// ---------------------------------------------------------------------------

test('FX3R-005 붙여넣기 진행 중 표시는 클립보드 값 단위로 전역이다 — 두 패널이 같은 잘라내기를 두 번 보내지 않는다', async () => {
  const clipboard = await loadClipboard();
  const client = await loadClient();
  clipboard.cutSelection({ sessionId: 's-1', paths: ['/work/a.txt'] });

  const post = deferred<{ jobId: string }>();
  const submitted: unknown[] = [];
  const panelA = { submit: (r: unknown) => { submitted.push(r); return post.promise; } };
  const panelB = { submit: async (r: unknown) => { submitted.push(r); return { jobId: 'job-b' }; } };

  const first = client.pasteFromClipboard({ client: panelA, target: { destSessionId: 's-1', destPath: '/work/x' } });
  const second = await client.pasteFromClipboard({ client: panelB, target: { destSessionId: 's-1', destPath: '/work/y' } });
  assert.equal(second, null, 'another panel pasted the same cut while the first was in flight');
  assert.equal(submitted.length, 1);
  post.resolve({ jobId: 'job-a' });
  assert.deepEqual(await first, { jobId: 'job-a' });
  assert.equal(clipboard.getFileExplorerClipboard(), null, 'the accepted cut is consumed');

  // A failed paste frees the value, so a retry goes through.
  const copy = clipboard.copySelection({ sessionId: 's-1', paths: ['/work/b.txt'] });
  await assert.rejects(client.pasteFromClipboard({ client: { submit: async () => { throw new Error('HTTP 500'); } }, target: { destSessionId: 's-1', destPath: '/work/x' } }));
  assert.equal(clipboard.getFileExplorerClipboard(), copy);
  assert.deepEqual(await client.pasteFromClipboard({ client: panelB, target: { destSessionId: 's-1', destPath: '/work/x' } }), { jobId: 'job-b' });
});

test('FX3R-005 패널은 자기만의 붙여넣기 단일 비행을 두지 않는다', () => {
  const win = source(WINDOW);
  assert.doesNotMatch(win, /\bcreateSingleFlight\s*\(/, 'a per-panel single flight lets two panels submit the same cut');
});

// ---------------------------------------------------------------------------
// FX3R-006 — the ownership glue
// ---------------------------------------------------------------------------

test('FX3R-006 패널의 소유권 effect 는 dispose 를 부르는 정리를 돌려주고, 폐기된 객체를 새로 만든다 (StrictMode)', () => {
  const win = source(WINDOW);
  const effect = hookCalls(win, 'useEffect').find((args) => /\bownership\s*\(\s*\)/.test(args) && /\.dispose\s*\(/.test(args));
  assert.ok(effect, 'no useEffect creates the ownership object and disposes it');
  assert.match(effect, /\breturn\s*\(\s*\)\s*=>[^;]*\.dispose\s*\(\s*\)/, 'the ownership effect must return a cleanup that calls dispose()');
  assert.match(effect, /ownershipRef\.current\s*\?\.\s*disposed[\s\S]*ownershipRef\.current\s*=\s*null/, 'a disposed object (StrictMode re-mount) must be replaced');
});

test('FX3R-006 jobClient.submit 과 WS 처리기는 소유권 ref 를 거친다', () => {
  const win = source(WINDOW);
  const client = /const\s+jobClient\s*=\s*useMemo\s*\(/.exec(win);
  assert.ok(client, 'jobClient = useMemo(...) not found');
  assert.match(bracketBody(win, client.index + client[0].length - 1), /\bownership\s*\(\s*\)\s*\.\s*claim\s*\(/, 'submit must claim the job through the ownership ref');

  const ws = hookCalls(win, 'registerFileJobHandler');
  assert.ok(ws.length >= 1, 'the panel registers no file job handler');
  const handler = ws.join('\n');
  assert.match(handler, /\bownership\s*\(\s*\)\s*\.\s*onDone\s*\(/, 'a finished job must reach ownership().onDone');
  assert.match(handler, /\bownership\s*\(\s*\)\s*\.\s*onDecision\s*\(/, 'a question must reach ownership().onDecision');
  const ownership = /const\s+ownership\s*=\s*useCallback\s*\(/.exec(win);
  assert.ok(ownership, 'ownership = useCallback(...) not found');
  assert.match(bracketBody(win, ownership.index + ownership[0].length - 1), /\bownershipRef\.current\b/, 'ownership() must read the ref');
});
