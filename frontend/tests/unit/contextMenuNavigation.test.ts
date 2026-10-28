import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  createContextMenuChildPage,
  createContextMenuRootPage,
  formatContextMenuPath,
  resolveContextMenuPages,
} from '../../src/components/ContextMenu/contextMenuNavigation.ts';
import type { ContextMenuActionItem, ContextMenuItem } from '../../src/components/ContextMenu/ContextMenu.tsx';

// FR-ARCH-013 AC-11: the phone menu (a dialog) shows the latest items. The server check of
// AC-8/AC-9 answers after the menu opened, so a dialog that keeps the first items stays on
// '확인 중…' for good.
const noop = () => undefined;
const pendingItems: ContextMenuItem[] = [
  { label: 'mobile.html 열기', description: '확인 중…', disabled: true, onClick: noop },
  { separator: true },
  { label: '화면의 파일', description: '확인 중…', disabled: true, children: [] },
];
const confirmedItems: ContextMenuItem[] = [
  { label: 'mobile.html 열기', description: '현재 폴더', onClick: noop },
  { separator: true },
  { label: '화면의 파일', children: [{ label: 'mobile.html', description: '현재 폴더', onClick: noop }] },
];

test('FR-ARCH-013 AC-11: the root page always shows the items it is given now', () => {
  const before = resolveContextMenuPages(pendingItems, []);
  assert.equal(before.length, 1);
  assert.equal(before[0].items, pendingItems);

  const after = resolveContextMenuPages(confirmedItems, []);
  assert.equal(after.length, 1);
  assert.equal(after[0].items, confirmedItems);
  assert.equal(formatContextMenuPath(after[0].path), '메뉴');
});

test('FR-ARCH-013 AC-11: an open submenu is looked up again in the latest items', () => {
  const pages = resolveContextMenuPages(confirmedItems, ['화면의 파일']);
  assert.equal(pages.length, 2);
  assert.equal(formatContextMenuPath(pages[1].path), '메뉴 > 화면의 파일');
  assert.deepEqual(pages[1].items.map((item) => (item as ContextMenuActionItem).label), ['mobile.html']);

  const refreshed: ContextMenuItem[] = [
    confirmedItems[0],
    { label: '화면의 파일', children: [{ label: 'a.md', onClick: noop }, { label: 'mobile.html', onClick: noop }] },
  ];
  const again = resolveContextMenuPages(refreshed, ['화면의 파일']);
  assert.deepEqual(again[1].items.map((item) => (item as ContextMenuActionItem).label), ['a.md', 'mobile.html']);
});

test('FR-ARCH-013 AC-11: a submenu that is gone or empty in the latest items closes back to its parent', () => {
  assert.equal(resolveContextMenuPages(pendingItems, ['화면의 파일']).length, 1);
  assert.equal(resolveContextMenuPages(confirmedItems, ['없는 메뉴']).length, 1);
  assert.equal(resolveContextMenuPages(confirmedItems, ['화면의 파일', 'mobile.html']).length, 2);
});

test('FR-ARCH-013 AC-11: MobileContextMenuDialog builds its pages from the items prop on every render', () => {
  const source = readFileSync(new URL('../../src/components/ContextMenu/ContextMenu.tsx', import.meta.url), 'utf8');
  const dialog = source.slice(source.indexOf('function MobileContextMenuDialog'));
  assert.doesNotMatch(dialog, /useState<ContextMenuNavigationPage\[\]>/, 'pages copied into state go stale');
  assert.match(dialog, /resolveContextMenuPages\(items,/);
});

test('mobile context menu navigation builds Korean path headers', () => {
  const commandItem: ContextMenuActionItem = {
    label: '커맨드 라인',
    children: [{ label: 'npm test', onClick: () => undefined }],
  };
  const root = createContextMenuRootPage([
    {
      label: '등록 항목 붙여넣기',
      children: [commandItem],
    },
  ]);
  const registered = createContextMenuChildPage(root, root.items[0] as ContextMenuActionItem);
  assert.ok(registered);
  const command = createContextMenuChildPage(registered, commandItem);

  assert.equal(formatContextMenuPath(root.path), '메뉴');
  assert.equal(formatContextMenuPath(registered.path), '메뉴 > 등록 항목 붙여넣기');
  assert.equal(formatContextMenuPath(command!.path), '메뉴 > 등록 항목 붙여넣기 > 커맨드 라인');
});

test('mobile context menu navigation returns null for leaf items', () => {
  const root = createContextMenuRootPage([{ label: 'leaf', onClick: () => undefined }]);
  assert.equal(createContextMenuChildPage(root, root.items[0] as ContextMenuActionItem), null);
});
