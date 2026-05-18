import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_CONTEXT_MENU_DEPTH,
  normalizeContextMenuItems,
} from '../../src/components/ContextMenu/contextMenuModel.ts';
import type { ContextMenuItem } from '../../src/components/ContextMenu/ContextMenu.tsx';

function action(label: string, children?: ContextMenuItem[]): ContextMenuItem {
  return {
    label,
    onClick: () => undefined,
    children,
  };
}

test('normalizeContextMenuItems keeps level 5 and strips level 6 children with diagnostics', () => {
  const diagnostics: string[] = [];
  const items = normalizeContextMenuItems([
    action('L1', [
      action('L2', [
        action('L3', [
          action('L4', [
            action('L5', [
              action('L6'),
            ]),
          ]),
        ]),
      ]),
    ]),
  ], {
    onDepthExceeded: (diagnostic) => {
      diagnostics.push(`${diagnostic.strippedLevel}:${diagnostic.path.join('/')}`);
    },
  });

  let current = items[0];
  for (let level = 1; level < MAX_CONTEXT_MENU_DEPTH; level += 1) {
    assert.equal(current.separator, undefined);
    current = current.children![0];
  }

  assert.equal(current.separator, undefined);
  assert.equal(current.label, 'L5');
  assert.equal(current.children, undefined);
  assert.deepEqual(diagnostics, ['6:L1/L2/L3/L4/L5/L6']);
});

test('normalizeContextMenuItems removes empty categories and trims separators', () => {
  const items = normalizeContextMenuItems([
    { separator: true },
    { label: 'empty category', children: [] },
    { separator: true },
    action('A'),
    { separator: true },
    { separator: true },
    action('B'),
    { separator: true },
  ]);

  assert.deepEqual(
    items.map(item => item.separator ? 'separator' : item.label),
    ['A', 'separator', 'B'],
  );
});

test('normalizeContextMenuItems preserves disabled action items with handlers', () => {
  const items = normalizeContextMenuItems([
    {
      label: '복사',
      disabled: true,
      onClick: () => undefined,
    },
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0].separator, undefined);
  assert.equal(items[0].label, '복사');
  assert.equal(items[0].disabled, true);
});
