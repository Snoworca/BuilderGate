import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// Review round fx4 -- wiring that only source can show. The decisions behind
// each fix are pure functions pinned elsewhere (fileExplorerTray.test.ts,
// fileExplorerModalModel.test.ts, windowDialogControlledRect.test.ts,
// fileJobStore.test.ts); these guards hold that the components route through
// them.
//
// Comments are stripped before any check, so prose can neither trip nor
// satisfy one. Every target file is required to exist: a missing file fails
// the case instead of passing it.

const SRC = new URL('../../src/', import.meta.url);

function read(path: string): string {
  const url = new URL(path, SRC);
  assert.ok(existsSync(url), `src/${path} is missing`);
  return readFileSync(url, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** The text from `start` to the first `end` after it. */
function between(source: string, start: string | RegExp, end: string, label: string): string {
  const match = typeof start === 'string' ? { index: source.indexOf(start), length: start.length } : (() => {
    const m = start.exec(source);
    return m === null ? { index: -1, length: 0 } : { index: m.index, length: m[0].length };
  })();
  assert.notEqual(match.index, -1, `${label}: start marker not found`);
  const stop = source.indexOf(end, match.index + match.length);
  assert.notEqual(stop, -1, `${label}: end marker not found`);
  return source.slice(match.index, stop + end.length);
}

function has(text: string, pattern: RegExp, message: string): void {
  assert.ok(pattern.test(text), message);
}

function lacks(text: string, pattern: RegExp, message: string): void {
  const hit = pattern.exec(text);
  assert.equal(hit, null, hit ? `${message} (found: ${hit[0].trim()})` : '');
}

test('[FR-FEX-009 AC-2] 상태바 응답 대기 버튼은 창 레코드가 없으면 decideReviveFileExplorerAction 을 거쳐 openFileExplorer 로 창을 연다', () => {
  const app = read('App.tsx');
  const hook = read('hooks/useFileExplorerWindows.ts');

  const bar = /<FileJobStatusBar\s+onRevive=\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(app);
  assert.ok(bar !== null, 'App.tsx: <FileJobStatusBar onRevive={handler}> must name a local handler');
  const handlerName = bar[1];
  const handler = between(app, new RegExp(`const\\s+${handlerName}\\s*=\\s*useCallback\\(`), '}, [', `App.tsx ${handlerName}`);
  has(handler, /\bdecideReviveFileExplorerAction\s*\(/, `App.tsx: ${handlerName} does not decide through decideReviveFileExplorerAction`);
  has(handler, /\bexplorer\s*\.\s*reviveFileExplorer\s*\(\s*workspaceId\s*\)/, `App.tsx: ${handlerName} does not switch workspace/screen through reviveFileExplorer`);
  has(handler, /\bexplorer\s*\.\s*openFileExplorer\s*\(\s*\{\s*workspaceId\s*,\s*originTabId\b/, `App.tsx: ${handlerName} does not open the missing window with the workspace's active tab`);
  has(handler, /\bactiveTabId\b/, `App.tsx: ${handlerName} does not pass the workspace's activeTabId`);

  // Revival must not bail out before navigating: the window opens where the user can see it.
  const revive = between(hook, 'const reviveFileExplorer = useCallback(', '}, [', 'reviveFileExplorer');
  lacks(revive, /windowsRef\.current\[workspaceId\]\s*===\s*undefined\s*\)\s*return/, 'reviveFileExplorer still returns early when the workspace has no window');
});

test('[FR-FEX-007 AC-2] 창 모달은 마운트 시 shouldFocusWindowModalOnMount 로 판단하고, 포커스가 호스트 안에 있는지 document.activeElement 로 본다', () => {
  const modal = read('components/fileExplorer/FileExplorerWindowModal.tsx');
  const surface = between(modal, 'function WindowModalSurface(', '\n}\n', 'WindowModalSurface');
  const focusEffect = between(surface, /useEffect\(\(\)\s*=>\s*\{[^}]*?\bfocus\(/, '}, []);', 'focus-on-mount effect');
  has(focusEffect, /\bshouldFocusWindowModalOnMount\s*\(\s*entry\.kind\s*,/, 'the mount focus is not decided by shouldFocusWindowModalOnMount(entry.kind, ...)');
  has(focusEffect, /\.contains\(\s*document\.activeElement\s*\)/, 'the mount focus does not check whether focus is already inside the host');
  lacks(focusEffect, /^\s*controls\(\)\[0\]\?\.focus\(\);/m, 'the first control is still focused unconditionally');
  // The Tab trap stays once focus is inside.
  has(surface, /event\.key\s*===\s*'Tab'[\s\S]*?nextFocusIndex\(/, 'the Tab trap is gone');
});

test('[FR-FEX-007 AC-4] 결정 POST 가 성공한 뒤에만 DECISION_ANSWERED 를 보내고, 실패하면 질문을 다시 묻는다', () => {
  const win = read('components/fileExplorer/FileExplorerWindow.tsx');
  const ask = between(win, 'const askDecision = useCallback(', '}, [', 'askDecision');
  const answered = ask.search(/dispatchFileJob\(\{\s*type:\s*'DECISION_ANSWERED'/);
  const decide = ask.search(/fileJobApi\.decide\(/);
  const cancel = ask.search(/fileJobApi\.cancel\(/);
  assert.notEqual(answered, -1, 'askDecision no longer dispatches DECISION_ANSWERED');
  assert.ok(decide !== -1 && cancel !== -1, 'askDecision no longer posts the answer');
  assert.ok(answered > decide && answered > cancel, 'DECISION_ANSWERED is dispatched before the POST resolves: a failed POST loses the question');
  has(ask, /await\s+fileJobApi\.decide\(/, 'the decide POST is not awaited before the question is settled');
  has(ask, /await\s+fileJobApi\.cancel\(/, 'the cancel POST is not awaited before the question is settled');
  const failure = ask.slice(ask.indexOf('.catch('));
  has(failure, /\.delete\(\s*route\.jobId\s*\)/, 'a failed POST keeps the question marked asked, so it is never put up again');
});

test('[FR-FEX-009 AC-3] 실패는 시작한 탭(failure.tabId)으로 보내고, 패널이 실제로 보였을 때만 FAILURE_SHOWN', () => {
  const win = read('components/fileExplorer/FileExplorerWindow.tsx');
  const show = between(win, 'const showJobError = useCallback(', '}, [', 'showJobError');
  has(show, /return\s+false\b/, 'showJobError does not report that no panel showed the failure');
  has(show, /return\s+true\b/, 'showJobError does not report that a panel showed the failure');
  has(show, /registry\.get\(\s*originTabId\s*\)/, 'showJobError does not look up the origin tab\'s panel');

  const effect = between(win, /useEffect\(\(\)\s*=>\s*\{\s*for\s*\(const failure of jobFailures\)/, '}, [', 'failure effect');
  has(effect, /showJobError\([\s\S]*?,\s*failure\.tabId\s*\)/, 'the failure is not routed to failure.tabId');
  has(effect, /if\s*\(\s*shown\s*\)\s*dispatchFileJob\(\{\s*type:\s*'FAILURE_SHOWN'/, 'FAILURE_SHOWN is dispatched even when no panel showed the failure');
});

test('[FR-FEX-009 AC-2] 목록 요청 시점의 seq 를 sinceSeq 로 SYNC_LIST 에 넘긴다', () => {
  const sync = read('hooks/useFileJobStoreSync.ts');
  const since = sync.search(/const\s+sinceSeq\s*=\s*getFileJobSnapshot\(\)\.seq/);
  const list = sync.search(/fileJobApi\.list\(/);
  assert.notEqual(since, -1, 'the snapshot seq is not taken when the list is requested');
  assert.ok(since < list, 'the seq is taken after the list request, so a job started meanwhile can still be reaped');
  has(sync, /type:\s*'SYNC_LIST',\s*sinceSeq\b/, 'SYNC_LIST does not carry sinceSeq');
});

test('[FR-FEX-004 AC-6] useStageRect 는 비활성일 때 null 을 파생하고 effect 안에서 setRect(null) 을 부르지 않는다', () => {
  const win = read('components/fileExplorer/FileExplorerWindow.tsx');
  const hook = between(win, 'function useStageRect(', '\n}\n', 'useStageRect');
  lacks(hook, /setRect\(\s*null\s*\)/, 'useStageRect clears its state from the effect (react-hooks/set-state-in-effect)');
  has(hook, /return\s+active\s*\?\s*rect\s*:\s*null\s*;/, 'useStageRect does not derive null when inactive');
});

test('[FR-MDE-012 AC-4] 편집기 트리 패널의 닫기는 접은 뒤 창 표면으로 포커스를 옮긴다 — 편집기 단축키가 죽지 않게', () => {
  const win = read('components/editor/EditorWindow.tsx');
  const pane = between(win, '<EditorFileTreePane', '/>', '<EditorFileTreePane>');
  const onClose = /onClose=\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(pane);
  assert.ok(onClose !== null, 'EditorWindow: <EditorFileTreePane onClose> must name a local handler');
  const handler = between(win, new RegExp(`const\\s+${onClose[1]}\\s*=\\s*useCallback\\(`), '}, [', onClose[1]);
  has(handler, /\bsetPaneOpen\(\s*false\s*\)/, `${onClose[1]} does not fold the pane`);
  has(handler, /surfaceRef\.current\??\.focus\(/, `${onClose[1]} leaves focus on the hidden close button, which falls to body`);
});

test('[FR-MDE-012 AC-2] iOS 는 길게 누름에 contextmenu 가 없다 — 탭 막대 빈 곳과 제목 표시줄 빈 곳의 길게 누름이 같은 창 메뉴를 연다', () => {
  const win = read('components/editor/EditorWindow.tsx');
  has(win, /import\s*\{\s*useLongPress\s*\}\s*from\s*'\.\.\/\.\.\/hooks\/useLongPress(?:\.ts)?'/, 'EditorWindow does not use the existing useLongPress hook');
  const call = /useLongPress\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(win);
  assert.ok(call !== null, 'useLongPress is not called with a named callback');
  const callback = between(win, new RegExp(`const\\s+${call[1]}\\s*=\\s*useCallback\\(`), '}, [', call[1]);
  has(callback, /\bsetWindowMenu\(/, `${call[1]} does not open the window menu`);

  // The opening tag of the host: its attributes are named handlers, so its first '>' closes it.
  const host = between(win, 'className="editor-tab-bar-host"', '>', 'tab bar host');
  has(host, /\bonContextMenu=/, 'the tab bar host lost its right-click menu');
  const start = /\bonTouchStart=\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(host);
  assert.ok(start !== null, 'the tab bar host has no long press (onTouchStart={handler})');
  has(host, /\bonTouchEnd=/, 'the tab bar host long press is never cancelled on release');
  has(host, /\bonTouchMove=/, 'the tab bar host long press is not cancelled by a drag');
  // Only the empty areas: a press on a tab or a title bar button is not the window's.
  const tabBarStart = between(win, `const ${start[1]} = `, '};', start[1]);
  has(tabBarStart, /\bisEditorWindowMenuTarget\(/, `${start[1]} does not use the same empty-area test as the right click`);

  const titlebar = between(win, "querySelector<HTMLElement>('.window-dialog-titlebar')", '}, [', 'title bar effect');
  has(titlebar, /addEventListener\(\s*'touchstart'/, 'the title bar has no long press');
  has(titlebar, /removeEventListener\(\s*'touchstart'/, 'the title bar long press listener is never removed');
  has(titlebar, /addEventListener\(\s*'touchend'/, 'the title bar long press is never cancelled on release');
  const titleStart = between(titlebar, 'const handleTitlebarTouchStart', '};', 'handleTitlebarTouchStart');
  has(titleStart, /\bisEditorWindowMenuTarget\(/, 'the title bar long press does not use the same empty-area test as the right click');
});
