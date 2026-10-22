import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { buildTerminalContextMenuItems, type BuildTerminalMenuOptions } from '../../src/utils/contextMenuBuilder.ts';
import { verifyScreenPaths } from '../../src/utils/terminalPathVerification.ts';
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
