import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { TerminalShortcutKeyDescriptor, TerminalShortcutState } from '../../src/types/terminalShortcut.ts';
import { matchesTodoShortcut, resolveTerminalShortcut } from '../../src/utils/terminalShortcutBindings.ts';
import { koCatalog } from './i18nTestSetup.ts';
import { buildTerminalContextMenuItems, type BuildTerminalMenuOptions } from '../../src/utils/contextMenuBuilder.ts';

const now = '2026-11-20T00:00:00.000Z';
const state: TerminalShortcutState = { version: 1, lastUpdated: now, profileSelections: [{ scope: 'global', profile: 'xterm-default', updatedAt: now }], bindings: [] };

function altT(overrides: Partial<TerminalShortcutKeyDescriptor> = {}): TerminalShortcutKeyDescriptor {
  return { key: 't', code: 'KeyT', ctrlKey: false, shiftKey: false, altKey: true, metaKey: false, location: 0, repeat: false, ...overrides };
}

function isToggle(event: TerminalShortcutKeyDescriptor, imeActive = false): boolean {
  const result = resolveTerminalShortcut({ event, state, workspaceId: 'ws', sessionId: 's', imeActive, hasSelection: false });
  return result.kind === 'matched' && result.action.type === 'toggle-todo';
}

test('FR-TODO-002 AC-2: Alt+T in a terminal toggles the to-do panel, by the physical key', () => {
  assert.ok(isToggle(altT()));
  assert.ok(isToggle(altT({ key: String.fromCharCode(0x3145) })));
  assert.equal(isToggle(altT({ shiftKey: true })), false);
  assert.equal(isToggle(altT(), true), false);
});

test('FR-TODO-002 AC-2: outside a terminal the same key is recognised', () => {
  assert.ok(matchesTodoShortcut(altT(), state));
  assert.equal(matchesTodoShortcut(altT({ altKey: false }), state), false);
});

test('FR-TODO-002 AC-2: a user binding on Alt+T wins, so the key can go back to the program', () => {
  const userState: TerminalShortcutState = {
    ...state,
    bindings: [{
      id: 'u1', scope: 'global', enabled: true, allowRepeat: false, matchByKeyFallback: false, sortOrder: 0, createdAt: now, updatedAt: now,
      key: 't', code: 'KeyT', ctrlKey: false, shiftKey: false, altKey: true, metaKey: false, location: 0,
      action: { type: 'pass-through' }, description: 'mine',
    }],
  };
  assert.equal(matchesTodoShortcut(altT(), userState), false);
});

function menu(todoPanel?: BuildTerminalMenuOptions['todoPanel']) {
  return buildTerminalContextMenuItems({
    tab: undefined, tabs: [], maxTabs: 8, onAddTab: () => undefined, onCloseTab: () => undefined,
    onCopy: async () => undefined, onPaste: async () => undefined, hasSelection: false,
    ...(todoPanel ? { todoPanel } : {}),
  });
}

test('FR-TODO-002 AC-2: the terminal context menu shows or hides the to-do panel', () => {
  const labels = (items: ReturnType<typeof menu>) => items.flatMap((entry) => (entry.separator ? [] : [entry.label]));
  assert.ok(labels(menu({ open: false, onToggle: () => undefined })).includes(koCatalog['contextMenu.todo.show']));
  assert.ok(labels(menu({ open: true, onToggle: () => undefined })).includes(koCatalog['contextMenu.todo.hide']));
  assert.equal(labels(menu()).includes(koCatalog['contextMenu.todo.show']), false);
});

test('FR-TODO-002 AC-2: both terminal menus offer it, and the terminal hands Alt+T to the app', () => {
  const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  const mosaic = readFileSync(new URL('../../src/components/Grid/MosaicContainer.tsx', import.meta.url), 'utf8');
  assert.match(app, /todoPanel: todoPanelMenuOption\(\)/u);
  assert.match(mosaic, /todoPanel: todoPanelMenuOption\(\)/u);
  const view = readFileSync(new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url), 'utf8');
  assert.match(view, /shortcutResolution\.action\.type === 'toggle-todo'\) \{\s*ev\.preventDefault\(\);\s*todoPanelStore\.toggle\(\);\s*return false;/u);
});
