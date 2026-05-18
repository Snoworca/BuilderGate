import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildRegisteredPresetContextMenuItem,
  buildTerminalContextMenuItems,
} from '../../src/utils/contextMenuBuilder.ts';
import type { CommandPreset } from '../../src/types/commandPreset.ts';

function preset(input: Partial<CommandPreset> & Pick<CommandPreset, 'kind' | 'label' | 'value' | 'sortOrder'>): CommandPreset {
  return {
    id: input.id ?? `${input.kind}-${input.label}`,
    kind: input.kind,
    label: input.label,
    value: input.value,
    sortOrder: input.sortOrder,
    createdAt: input.createdAt ?? '2026-05-18T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-05-18T00:00:00.000Z',
  };
}

test('registered preset context menu returns null when no categories have items', () => {
  assert.equal(
    buildRegisteredPresetContextMenuItem({ presets: [], onSelectPreset: () => undefined }),
    null,
  );
});

test('registered preset context menu hides empty categories and sorts by sortOrder then label', () => {
  const menu = buildRegisteredPresetContextMenuItem({
    presets: [
      preset({ kind: 'command', label: 'z', value: 'z', sortOrder: 2 }),
      preset({ kind: 'command', label: 'a', value: 'a', sortOrder: 2 }),
      preset({ kind: 'command', label: 'first', value: 'first', sortOrder: 1 }),
    ],
    onSelectPreset: () => undefined,
  });

  assert.ok(menu && !menu.separator);
  assert.equal(menu.label, '등록 항목 붙여넣기');
  assert.deepEqual(menu.children?.map(item => item.separator ? 'separator' : item.label), ['커맨드 라인']);

  const commandCategory = menu.children?.[0];
  assert.ok(commandCategory && !commandCategory.separator);
  assert.deepEqual(
    commandCategory.children?.map(item => item.separator ? 'separator' : item.label),
    ['first', 'a', 'z'],
  );
});

test('registered preset context menu renders only non-empty categories in fixed order', () => {
  const cases: Array<{
    name: string;
    presets: CommandPreset[];
    labels: string[];
  }> = [
    {
      name: 'command-only',
      presets: [preset({ kind: 'command', label: 'cmd', value: 'cmd', sortOrder: 1 })],
      labels: ['커맨드 라인'],
    },
    {
      name: 'directory-only',
      presets: [preset({ kind: 'directory', label: 'dir', value: 'C:\\Work', sortOrder: 1 })],
      labels: ['디렉토리'],
    },
    {
      name: 'prompt-only',
      presets: [preset({ kind: 'prompt', label: 'prompt', value: 'review', sortOrder: 1 })],
      labels: ['프롬프트'],
    },
    {
      name: 'multi-kind',
      presets: [
        preset({ kind: 'prompt', label: 'prompt', value: 'review', sortOrder: 1 }),
        preset({ kind: 'command', label: 'cmd', value: 'cmd', sortOrder: 1 }),
      ],
      labels: ['커맨드 라인', '프롬프트'],
    },
  ];

  for (const item of cases) {
    const menu = buildRegisteredPresetContextMenuItem({
      presets: item.presets,
      onSelectPreset: () => undefined,
    });

    assert.ok(menu && !menu.separator, item.name);
    assert.deepEqual(
      menu.children?.map(child => child.separator ? 'separator' : child.label),
      item.labels,
      item.name,
    );
  }
});

test('terminal context menu appends registered preset menu as the final item', () => {
  const items = buildTerminalContextMenuItems({
    tab: undefined,
    tabs: [],
    maxTabs: 8,
    onAddTab: () => undefined,
    onCloseTab: () => undefined,
    onCopy: async () => undefined,
    onPaste: async () => undefined,
    hasSelection: false,
    registeredPresetMenu: {
      presets: [preset({ kind: 'prompt', label: 'ask', value: 'ask', sortOrder: 1 })],
      onSelectPreset: () => undefined,
    },
  });

  const lastItem = items[items.length - 1];
  assert.ok(lastItem && !lastItem.separator);
  assert.equal(lastItem.label, '등록 항목 붙여넣기');
});
