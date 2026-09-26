import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isIconName } from '../../src/components/common/iconGlyphs.ts';
import { workspaceActivity } from '../../src/components/Workspace/workspaceActivity.ts';
import {
  buildRegisteredPresetContextMenuItem,
  buildTerminalContextMenuItems,
  type BuildTerminalMenuOptions,
} from '../../src/utils/contextMenuBuilder.ts';
import type { ContextMenuActionItem, ContextMenuItem } from '../../src/components/ContextMenu/ContextMenu.tsx';

const isAction = (item: ContextMenuItem): item is ContextMenuActionItem => !item.separator;

// FR-UIDS-005 — the terminal context menu draws shared icons, and each
// workspace row carries a dot that says whether any of its sessions runs.

function menu(overrides: Partial<BuildTerminalMenuOptions> = {}) {
  return buildTerminalContextMenuItems({
    tab: undefined,
    tabs: [],
    maxTabs: 8,
    onAddTab: () => undefined,
    onCloseTab: () => undefined,
    onCopy: async () => undefined,
    onPaste: async () => undefined,
    hasSelection: true,
    moveWorkspace: { disabled: false, onRequest: () => undefined },
    onOpenFileExplorer: () => undefined,
    ...overrides,
  });
}

test('FR-UIDS-005 AC-1: every top-level terminal menu item names a shared icon, the file explorer included', () => {
  const items = menu().filter((item) => !item.separator);
  const labels = items.map((item) => item.label);
  assert.deepEqual(labels, ['새 세션', '세션 닫기', 'Workspace 이동', '파일 탐색기 열기', '복사', '붙여넣기']);
  for (const item of items) {
    assert.ok(item.icon, `${item.label} has no icon`);
    assert.equal(isIconName(item.icon!), true, `${item.label} draws "${item.icon}", not a shared icon`);
  }
  assert.equal(items.find((item) => item.label === '파일 탐색기 열기')?.icon, 'folder');
});

test('FR-UIDS-005 AC-1: the new-session submenu keeps the shells the server sends, under a shared icon', () => {
  const items = menu({
    availableShells: [
      { id: 'powershell', label: 'PowerShell', icon: '💠' },
      { id: 'cmd', label: 'Command Prompt', icon: '⬛' },
    ] as BuildTerminalMenuOptions['availableShells'],
  });
  const newSession = items.filter(isAction).find((item) => item.label === '새 세션');
  assert.equal(newSession?.icon, 'plus');
  const shellIcons = (newSession?.children ?? []).filter(isAction).map((child) => child.icon);
  assert.ok(shellIcons.includes('⬛'), 'a shell icon from the server is left as sent');
});

test('FR-UIDS-005 AC-1: the registered-preset entry draws a shared icon too', () => {
  const item = buildRegisteredPresetContextMenuItem({
    presets: [{
      id: 'p', kind: 'command', label: 'build', value: 'npm run build', sortOrder: 0,
      createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
    }],
    onSelectPreset: () => undefined,
  });
  assert.ok(item && !item.separator);
  assert.equal(isIconName(item.icon ?? ''), true, `the registered-preset entry draws "${item.icon}"`);
});

test('FR-UIDS-005 AC-2/AC-3: a workspace is running while any of its tabs runs, and says so in words', () => {
  assert.deepEqual(workspaceActivity(0), { running: false, label: '대기' });
  assert.deepEqual(workspaceActivity(1), { running: true, label: '실행 중' });
  assert.deepEqual(workspaceActivity(3), { running: true, label: '실행 중' });
});

test('FR-UIDS-005 AC-2: the row draws the dot left of the name, green only while running', () => {
  const source = readFileSync(new URL('../../src/components/Workspace/WorkspaceItem.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../src/components/Workspace/Workspace.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const dotAt = source.indexOf('workspace-item-dot');
  assert.notEqual(dotAt, -1, 'WorkspaceItem draws a workspace-item-dot');
  assert.ok(dotAt < source.indexOf('workspace-item-name'), 'the dot comes before the name');
  assert.match(source, /workspaceActivity\(runningCount\)/, 'the dot follows the running count');
  const dot = /\.workspace-item-dot\s*\{([^}]*)\}/.exec(css);
  assert.ok(dot, 'Workspace.css styles .workspace-item-dot');
  assert.match(dot[1], /width:\s*8px/);
  assert.match(dot[1], /height:\s*8px/);
  const running = /\.workspace-item-dot\.is-running\s*\{([^}]*)\}/.exec(css);
  assert.ok(running, 'a running dot has its own rule');
  assert.match(running[1], /background(?:-color)?:\s*var\(--ok\)/);
});
