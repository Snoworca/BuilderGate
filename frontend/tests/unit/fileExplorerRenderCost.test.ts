import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// FR-FEX-002 AC-8 / FR-FEX-003 AC-10 — what the explorer recomputes per render
// and per scroll event. None of this has a DOM harness, so the thin React glue
// is held by its source: the window must receive the stable actions object, not
// the whole hook result, and the scroll handler must not read every row's
// position on each event.
//
// Comments are stripped first, so prose can neither trip nor satisfy a check.

const SRC = new URL('../../src/', import.meta.url);

function source(rel: string): string {
  return readFileSync(new URL(rel, SRC), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}

// The text between the bracket at `open` and its partner. Good enough for
// these files: no bracket characters inside the strings it walks over.
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

function useCallbackBody(text: string, name: string): string {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*useCallback\\s*\\(`).exec(text);
  assert.ok(m, `const ${name} = useCallback(...) not found`);
  return bracketBody(text, m.index + m[0].length - 1);
}

test('FX3-004 App 이 창에 넘기는 actions 는 훅 결과 전체가 아니라 콜백만 담은 안정된 객체다', () => {
  const app = source('App.tsx');
  const tags = [...app.matchAll(/<FileExplorerWindow\b/g)];
  assert.ok(tags.length >= 1, 'App.tsx must mount <FileExplorerWindow>');
  for (const tag of tags) {
    const end = app.indexOf('/>', tag.index);
    const attr = /\sactions\s*=\s*\{([^}]*)\}/.exec(app.slice(tag.index, end));
    assert.ok(attr, '<FileExplorerWindow> has no actions');
    assert.match(attr[1].trim(), /^\w+\.actions$/, `actions={${attr[1].trim()}} re-renders every panel whenever a terminal's status or cwd changes`);
  }

  const hook = source('hooks/useFileExplorerWindows.ts');
  const m = /const\s+actions\s*=\s*useMemo\s*(?:<[^>]*>)?\s*\(/.exec(hook);
  assert.ok(m, 'useFileExplorerWindows must build `actions` with its own useMemo');
  const args = bracketBody(hook, m.index + m[0].length - 1);
  const deps = /\[([^\]]*)\]\s*$/.exec(args.trim());
  assert.ok(deps, 'the actions useMemo has no dependency list');
  for (const unstable of ['views', 'windows', 'tabs', 'screen', 'workspaces', 'activeWorkspaceId', 'resolveTabSession']) {
    assert.doesNotMatch(deps[1], new RegExp(`\\b${unstable}\\b`), `actions depends on ${unstable}, which changes with every terminal flip`);
  }
  assert.match(hook, /\bactions\s*,/, 'the hook result must carry `actions`');
});

test('FX3-004 목록 행은 루트 목록 항목과 정렬로만 다시 계산된다 — 선택 클릭마다 정렬하지 않는다', () => {
  for (const rel of ['components/fileExplorer/FileExplorerWindow.tsx', 'components/fileExplorer/FileListView.tsx']) {
    const text = source(rel);
    const m = /=\s*useMemo\s*\(\s*\(\s*\)\s*=>\s*selectListRows\s*\(/.exec(text);
    assert.ok(m, `${rel}: selectListRows(...) must be memoized`);
    const args = bracketBody(text, text.indexOf('(', m.index + m[0].indexOf('useMemo')));
    const deps = /\[([^\]]*)\]\s*$/.exec(args.trim());
    assert.ok(deps, `${rel}: the selectListRows memo has no dependency list`);
    assert.doesNotMatch(deps[1], /\bstate\b(?!\.)|\btree\b(?!\.)/, `${rel}: keyed on the whole tree state, which changes on every click`);
    assert.match(deps[1], /\bsort\b/, `${rel}: the memo must be keyed on the sort`);
  }
  const listView = source('components/fileExplorer/fileListView.ts');
  assert.doesNotMatch(listView, /\blocaleCompare\s*\(/, 'localeCompare with a locale builds a collator per comparison');
  assert.match(listView, /^const\s+\w+\s*=\s*new\s+Intl\.Collator\s*\(\s*['"]ko['"]/m, 'one module-level Intl.Collator("ko") sorts names');
});

test('FX3-009 스크롤 이벤트마다 행 위치를 읽지 않는다 — 기준 행 탐색은 디바운스 타이머 안에서 한 번', () => {
  const win = source('components/fileExplorer/FileExplorerWindow.tsx');
  const onScroll = /\sonScroll\s*=\s*\{\s*(\w+)\s*\}/.exec(win);
  assert.ok(onScroll, 'the scroll container must name its onScroll handler');
  const handler = useCallbackBody(win, onScroll[1]);
  assert.doesNotMatch(handler, /\bgetBoundingClientRect\s*\(/, `${onScroll[1]} reads row positions on every scroll event`);
  const timer = /\bsetTimeout\s*\(\s*(\w+)\s*,/.exec(handler);
  assert.ok(timer, `${onScroll[1]} must defer the anchor commit with setTimeout`);
  const commit = useCallbackBody(win, timer[1]);
  assert.match(commit, /\bgetBoundingClientRect\s*\(/, `${timer[1]}: the top-row search belongs in the settled commit`);
});
