import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { buildTerminalContextMenuItems, type BuildTerminalMenuOptions } from '../../src/utils/contextMenuBuilder.ts';
import { checkMenuPaths, MENU_PATH_CHECK_TIMEOUT_MS, verifyScreenPaths } from '../../src/utils/terminalPathVerification.ts';
import { findPathsInRows } from '../../src/utils/terminalPathDetection.ts';
import type { PathStat } from '../../src/types/index.ts';

// FR-ARCH-013 AC-8: "화면의 파일" listed every path-like text on screen, and a
// pick of one that did not exist only then answered "file not found" (user
// report 2026-10-22). The list now holds the paths the server confirms openable.
type Target = { path: string; alternatives: string[] };
const target = (path: string, alternatives: string[] = []): Target => ({ path, alternatives });

const FILES: Record<string, PathStat['kind']> = {
  'docs/a.md': 'file',
  'docs': 'directory',
  'src/b.ts': 'file',
  'image.bin': 'file',
};
const stat = async (path: string): Promise<PathStat> => {
  const kind = FILES[path];
  if (kind === undefined) throw new Error('Path not found');
  return { path: `C:\\work\\${path}`, kind } as PathStat;
};

test('FR-ARCH-013 AC-8: only paths the server confirms openable stay, in screen order', async () => {
  const verified = await verifyScreenPaths(
    [target('missing.md'), target('docs/a.md'), target('docs'), target('image.bin'), target('src/b.ts')],
    stat,
  );
  assert.deepEqual(verified.map(t => t.path), ['docs/a.md', 'src/b.ts']);
});

test('FR-ARCH-013 AC-8: a path whose fallback piece exists stays, as the open would find it', async () => {
  const verified = await verifyScreenPaths([target('src/b.ts-cut', ['src/b.ts'])], stat);
  assert.deepEqual(verified.map(t => t.path), ['src/b.ts-cut']);
});

test('FR-ARCH-013 AC-8: nothing on screen asks the server nothing', async () => {
  let calls = 0;
  const verified = await verifyScreenPaths([], async (p) => { calls += 1; return stat(p); });
  assert.deepEqual(verified, []);
  assert.equal(calls, 0);
});

function base(openPath: BuildTerminalMenuOptions['openPath']): BuildTerminalMenuOptions {
  return {
    tab: undefined, tabs: [], maxTabs: 8,
    onAddTab: () => undefined, onCloseTab: () => undefined,
    onCopy: async () => undefined, onPaste: async () => undefined,
    hasSelection: false, openPath,
  };
}

test('FR-ARCH-013 AC-8: while the check runs the entry is shown disabled as checking', () => {
  const items = buildTerminalContextMenuItems(base({ near: null, screen: [], screenPending: true, onOpen: () => undefined }));
  const entry = items.find(item => !item.separator && item.label === '화면의 파일');
  assert.ok(entry && !entry.separator);
  assert.equal(entry.disabled, true);
  assert.equal(entry.description, '확인 중…');
});

test('FR-ARCH-013 AC-8: both terminal menus list the verified paths', () => {
  for (const file of ['../../src/App.tsx', '../../src/components/Grid/MosaicContainer.tsx']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /useVerifiedScreenPaths\(/, `${file} does not verify the screen paths`);
    assert.match(source, /screenPending/, `${file} does not pass the checking state`);
  }
});

// FR-ARCH-012 AC-9: a WSL shell prints BuilderGate's own shell-integration line,
// PROMPT_COMMAND='printf "%s" "$PWD" > "/mnt/c/.../buildergate-cwd-<id>.txt"', and
// that internal file was offered as "<name> 열기"; from a WSL home it answered
// PATH_TRAVERSAL (user report 2026-10-22, reproduced on 2222).

const row = (text: string) => ({ text, colOf: [...text].map((_, i) => i), isWrapped: false });

test('FR-ARCH-012 AC-9: the shell-integration cwd file is not a path', () => {
  const line = `PROMPT_COMMAND='printf "%s" "$PWD" > "/mnt/c/Users/beom/AppData/Local/Temp/buildergate-cwd-fe22e16d-8d0e-48c6-9854-3585948322c7.txt"' see docs/a.md`;
  const paths = findPathsInRows([row(line)], 400).map(found => found.path);
  assert.deepEqual(paths, ['docs/a.md']);
  const windows = findPathsInRows([row('C:\\Users\\beom\\AppData\\Local\\Temp\\buildergate-cwd-1.txt')], 200);
  assert.deepEqual(windows, []);
});

test('FR-ARCH-013 AC-9: the open item near the press is disabled as checking until confirmed', () => {
  const near = target('docs/a.md');
  const pending = buildTerminalContextMenuItems(base({ near, nearPending: true, screen: [], onOpen: () => undefined }));
  const first = pending[0];
  assert.ok(first && !first.separator);
  assert.equal(first.label, 'a.md 열기');
  assert.equal(first.disabled, true);
  assert.equal(first.description, '확인 중…');

  const confirmed = buildTerminalContextMenuItems(base({ near, nearPending: false, screen: [], onOpen: () => undefined }));
  const ready = confirmed[0];
  assert.ok(ready && !ready.separator);
  assert.notEqual(ready.disabled, true);
});

test('FR-ARCH-013 AC-9: both menus take the verified near path', () => {
  for (const file of ['../../src/App.tsx', '../../src/components/Grid/MosaicContainer.tsx']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /nearPending/, `${file} does not pass the near checking state`);
  }
});

// FR-ARCH-013 AC-12: the check had no time limit. A stat that never answers (a phone whose
// network dropped, a busy server) left the menu on '확인 중…' for good. After the limit the
// menu shows the unchecked paths; a pick still runs the open check (AC-5).
const neverAnswers = (): Promise<PathStat> => new Promise<PathStat>(() => undefined);

test('FR-ARCH-013 AC-12: the menu check is limited to five seconds', () => {
  assert.equal(MENU_PATH_CHECK_TIMEOUT_MS, 5000);
});

test('FR-ARCH-013 AC-12: a check that does not answer in time ends with the unchecked paths', async () => {
  const paths = { near: target('docs/a.md'), screen: [target('docs/a.md'), target('missing.md')] };
  const started = Date.now();
  const result = await checkMenuPaths(paths, neverAnswers, 30);
  assert.ok(Date.now() - started < 1000, 'the deadline ends the wait');
  assert.deepEqual(result.near, paths.near);
  assert.deepEqual(result.screen.map(t => t.path), ['docs/a.md', 'missing.md']);
});

test('FR-ARCH-013 AC-8/AC-9/AC-12: a check that answers in time keeps only the openable paths', async () => {
  const paths = { near: target('missing.md'), screen: [target('docs/a.md'), target('docs'), target('src/b.ts')] };
  const result = await checkMenuPaths(paths, stat, 1000);
  assert.equal(result.near, null);
  assert.deepEqual(result.screen.map(t => t.path), ['docs/a.md', 'src/b.ts']);
});

test('FR-ARCH-013 AC-12: the menu hook checks through the time-limited checkMenuPaths', () => {
  const hook = readFileSync(new URL('../../src/hooks/useVerifiedScreenPaths.ts', import.meta.url), 'utf8');
  assert.match(hook, /checkMenuPaths\(/);
  assert.doesNotMatch(hook, /verifyScreenPaths\(/, 'a direct verifyScreenPaths call has no deadline');
});
