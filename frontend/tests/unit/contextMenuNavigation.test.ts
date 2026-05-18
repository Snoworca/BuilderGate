import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createContextMenuChildPage,
  createContextMenuRootPage,
  formatContextMenuPath,
} from '../../src/components/ContextMenu/contextMenuNavigation.ts';
import type { ContextMenuActionItem } from '../../src/components/ContextMenu/ContextMenu.tsx';

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
