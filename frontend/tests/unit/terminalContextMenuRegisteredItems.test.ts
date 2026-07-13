import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildRegisteredPresetContextMenuItem,
  buildTerminalContextMenuItems,
  type BuildTerminalMenuOptions,
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

function terminalMenuBase(overrides: Partial<BuildTerminalMenuOptions> = {}): BuildTerminalMenuOptions {
  return {
    tab: undefined,
    tabs: [],
    maxTabs: 8,
    onAddTab: () => undefined,
    onCloseTab: () => undefined,
    onCopy: async () => undefined,
    onPaste: async () => undefined,
    hasSelection: true,
    ...overrides,
  };
}

function hasMenuLabel(items: ReturnType<typeof buildTerminalContextMenuItems>, label: string): boolean {
  return items.some(item => !item.separator && item.label === label);
}

test('복사 항목은 기본(마우스 트래킹 비활성)에서 표시된다', () => {
  const items = buildTerminalContextMenuItems(terminalMenuBase());
  assert.ok(hasMenuLabel(items, '복사'));
  assert.ok(hasMenuLabel(items, '붙여넣기'));
});

test('mouseTrackingActive 이면 복사 항목을 숨기고 붙여넣기는 유지한다', () => {
  const items = buildTerminalContextMenuItems(terminalMenuBase({ mouseTrackingActive: true }));
  assert.ok(!hasMenuLabel(items, '복사'), '마우스 트래킹 모드에서는 복사 항목이 없어야 한다');
  assert.ok(hasMenuLabel(items, '붙여넣기'), '붙여넣기는 마우스 트래킹 모드에서도 유지되어야 한다');
});

test('mouseTrackingActive 가 false 면 복사 항목을 유지한다', () => {
  const items = buildTerminalContextMenuItems(terminalMenuBase({ mouseTrackingActive: false }));
  assert.ok(hasMenuLabel(items, '복사'));
});

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

test('terminal context menu exposes move-to-workspace item and preserves disabled state', () => {
  let requested = false;
  const enabledItems = buildTerminalContextMenuItems({
    tab: undefined,
    tabs: [],
    maxTabs: 8,
    onAddTab: () => undefined,
    onCloseTab: () => undefined,
    onCopy: async () => undefined,
    onPaste: async () => undefined,
    hasSelection: false,
    moveWorkspace: {
      disabled: false,
      onRequest: () => {
        requested = true;
      },
    },
  });

  const moveItem = enabledItems.find(item => !item.separator && item.label === '워크스페이스 이동');
  assert.ok(moveItem && !moveItem.separator);
  assert.equal(moveItem.disabled, false);
  moveItem.onClick?.();
  assert.equal(requested, true);

  const disabledItems = buildTerminalContextMenuItems({
    tab: undefined,
    tabs: [],
    maxTabs: 8,
    onAddTab: () => undefined,
    onCloseTab: () => undefined,
    onCopy: async () => undefined,
    onPaste: async () => undefined,
    hasSelection: false,
    moveWorkspace: {
      disabled: true,
      onRequest: () => {
        throw new Error('disabled item should not invoke move');
      },
    },
  });

  const disabledMoveItem = disabledItems.find(item => !item.separator && item.label === '워크스페이스 이동');
  assert.ok(disabledMoveItem && !disabledMoveItem.separator);
  assert.equal(disabledMoveItem.disabled, true);
  assert.equal(typeof disabledMoveItem.onClick, 'function');
});
