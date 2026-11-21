import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type {
  TerminalShortcutBinding,
  TerminalShortcutKeyDescriptor,
  TerminalShortcutState,
} from '../../src/types/terminalShortcut.ts';
import {
  COMPOSER_SHORTCUT_BINDING,
  resolveTerminalShortcut,
} from '../../src/utils/terminalShortcutBindings.ts';
import { koCatalog } from './i18nTestSetup.ts';
import {
  buildTerminalContextMenuItems,
  type BuildTerminalMenuOptions,
} from '../../src/utils/contextMenuBuilder.ts';

const now = '2026-11-19T00:00:00.000Z';

function state(profile: 'xterm-default' | 'ai-tui-compat', bindings: TerminalShortcutBinding[] = []): TerminalShortcutState {
  return { version: 1, lastUpdated: now, profileSelections: [{ scope: 'global', profile, updatedAt: now }], bindings };
}

function altN(overrides: Partial<TerminalShortcutKeyDescriptor> = {}): TerminalShortcutKeyDescriptor {
  return { key: 'n', code: 'KeyN', ctrlKey: false, shiftKey: false, altKey: true, metaKey: false, location: 0, repeat: false, ...overrides };
}

function resolve(event: TerminalShortcutKeyDescriptor, shortcutState: TerminalShortcutState | null, imeActive = false) {
  return resolveTerminalShortcut({ event, state: shortcutState, workspaceId: 'ws', sessionId: 's', imeActive, hasSelection: false });
}

function isToggle(result: ReturnType<typeof resolve>): boolean {
  return result.kind === 'matched' && result.action.type === 'toggle-composer';
}

test('FR-CMP-001 AC-3: Alt+N toggles the composer by default in every profile', () => {
  assert.ok(isToggle(resolve(altN(), state('xterm-default'))));
  assert.ok(isToggle(resolve(altN(), state('ai-tui-compat'))));
});

test('FR-CMP-001 AC-3: Alt+N works before the shortcut settings load', () => {
  assert.ok(isToggle(resolve(altN(), null)));
});

test('FR-CMP-001 AC-3: matched by the physical key, so macOS Option+N (a dead key) and Hangul mode still match', () => {
  assert.ok(isToggle(resolve(altN({ key: 'Dead' }), state('xterm-default'))));
  assert.ok(isToggle(resolve(altN({ key: String.fromCharCode(0x315c) }), state('xterm-default'))));
});

test('FR-CMP-001 AC-3: other modifier combinations on N are not the toggle', () => {
  assert.equal(isToggle(resolve(altN({ shiftKey: true }), state('xterm-default'))), false);
  assert.equal(isToggle(resolve(altN({ ctrlKey: true }), state('xterm-default'))), false);
  assert.equal(isToggle(resolve(altN({ altKey: false }), state('xterm-default'))), false);
});

test('FR-CMP-001 AC-3: nothing toggles during an IME composition', () => {
  assert.equal(isToggle(resolve(altN(), state('xterm-default'), true)), false);
});

function userBinding(overrides: Partial<TerminalShortcutBinding>): TerminalShortcutBinding {
  return {
    id: 'user-1', scope: 'global', key: 'n', code: 'KeyN', ctrlKey: false, shiftKey: false, altKey: true, metaKey: false,
    location: 0, action: { type: 'pass-through' }, enabled: true, allowRepeat: false, matchByKeyFallback: false,
    sortOrder: 0, createdAt: now, updatedAt: now, ...overrides,
  };
}

test('FR-CMP-001 AC-3: a user binding on Alt+N wins, so the key can go back to the program', () => {
  const result = resolve(altN(), state('xterm-default', [userBinding({})]));
  assert.equal(result.kind, 'pass-through');
});

test('FR-CMP-001 AC-3: the toggle can be bound to another key', () => {
  const custom = userBinding({ key: 'i', code: 'KeyI', ctrlKey: true, altKey: true, action: { type: 'toggle-composer' } });
  assert.ok(isToggle(resolve(altN({ key: 'i', code: 'KeyI', ctrlKey: true }), state('xterm-default', [custom]))));
});

test('FR-CMP-001 AC-3: the built-in binding is Alt+N on KeyN and the action has a name in the settings', () => {
  assert.equal(COMPOSER_SHORTCUT_BINDING.code, 'KeyN');
  assert.equal(COMPOSER_SHORTCUT_BINDING.altKey, true);
  assert.equal(COMPOSER_SHORTCUT_BINDING.ctrlKey || COMPOSER_SHORTCUT_BINDING.shiftKey || COMPOSER_SHORTCUT_BINDING.metaKey, false);
  // The view model imports without extensions, so it is read here rather than loaded.
  const viewModel = readFileSync(new URL('../../src/components/TerminalShortcutManager/shortcutBindingViewModel.ts', import.meta.url), 'utf8');
  assert.match(viewModel, /action\.type === 'toggle-composer'\) return t\('shortcut\.action\.toggleComposer'\)/u);
  const editor = readFileSync(new URL('../../src/components/TerminalShortcutManager/ShortcutActionEditor.tsx', import.meta.url), 'utf8');
  assert.match(editor, /<option value="toggle-composer">\{t\('shortcut\.action\.toggleComposer'\)\}<\/option>/u);
  assert.equal(koCatalog['shortcut.action.toggleComposer'], '입력창 표시/숨기기');
});

test('FR-CMP-001 AC-3: the terminal key handler hands the toggle to the app instead of the program', () => {
  const view = readFileSync(new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url), 'utf8');
  assert.match(view, /shortcutResolution\.action\.type === 'toggle-composer'\) \{\s*ev\.preventDefault\(\);\s*onComposerShortcutRef\.current\?\.\(\);\s*return false;/u);
});

// FR-CMP-001 AC-4: the terminal menu.
function base(overrides: Partial<BuildTerminalMenuOptions> = {}): BuildTerminalMenuOptions {
  return {
    tab: undefined, tabs: [], maxTabs: 8, onAddTab: () => undefined, onCloseTab: () => undefined,
    onCopy: async () => undefined, onPaste: async () => undefined, hasSelection: false, ...overrides,
  };
}

function labels(items: ReturnType<typeof buildTerminalContextMenuItems>): string[] {
  return items.flatMap(item => (item.separator ? [] : [item.label]));
}

test('FR-CMP-001 AC-4: the terminal menu offers to show a closed composer and hide an open one', () => {
  let toggles = 0;
  const closed = buildTerminalContextMenuItems(base({ composer: { open: false, onToggle: () => { toggles += 1; } } }));
  const show = closed.find(item => !item.separator && item.label === '입력창 표시');
  assert.ok(show && !show.separator, labels(closed).join(', '));
  show.onClick?.();
  assert.equal(toggles, 1);
  const open = buildTerminalContextMenuItems(base({ composer: { open: true, onToggle: () => undefined } }));
  assert.ok(labels(open).includes('입력창 숨기기'));
  assert.ok(!labels(open).includes('입력창 표시'));
});

test('FR-CMP-001 AC-4: a caller that does not pass the option gets the menu it got before', () => {
  const items = labels(buildTerminalContextMenuItems(base()));
  assert.ok(!items.includes('입력창 표시') && !items.includes('입력창 숨기기'));
});

test('FR-CMP-001 AC-4: both terminal menus offer it, on every screen', () => {
  const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  const mosaic = readFileSync(new URL('../../src/components/Grid/MosaicContainer.tsx', import.meta.url), 'utf8');
  assert.match(app, /composer: composerMenuOption\(composerHost, targetTab\.id\)/u);
  assert.match(mosaic, /composer: composerHost \? composerMenuOption\(composerHost, tabId\) : undefined/u);
});
