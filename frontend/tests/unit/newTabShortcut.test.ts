// FR-ARCH-018: Alt+Shift+T opens a new tab like the tab bar + button.
import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { TerminalShortcutKeyDescriptor, TerminalShortcutState } from '../../src/types/terminalShortcut.ts';
import {
  appShortcutForWindowKey,
  resolveTerminalShortcut,
} from '../../src/utils/terminalShortcutBindings.ts';
import { actionLabel } from '../../src/components/TerminalShortcutManager/shortcutBindingViewModel.ts';
import { resolveNewTabRequest } from '../../src/hooks/newTabRequest.ts';
import { requestNewTab, subscribeNewTabRequests } from '../../src/utils/newTabRequests.ts';
import { koCatalog } from './i18nTestSetup.ts';

const now = '2026-11-26T00:00:00.000Z';
const state: TerminalShortcutState = { version: 1, lastUpdated: now, profileSelections: [{ scope: 'global', profile: 'xterm-default', updatedAt: now }], bindings: [] };
const tuiState: TerminalShortcutState = { ...state, profileSelections: [{ scope: 'global', profile: 'ai-tui-compat', updatedAt: now }] };

function altShiftT(overrides: Partial<TerminalShortcutKeyDescriptor> = {}): TerminalShortcutKeyDescriptor {
  return { key: 'T', code: 'KeyT', ctrlKey: false, shiftKey: true, altKey: true, metaKey: false, location: 0, repeat: false, ...overrides };
}

function actionIn(event: TerminalShortcutKeyDescriptor, shortcutState: TerminalShortcutState | null = state, imeActive = false): string | null {
  const result = resolveTerminalShortcut({ event, state: shortcutState, workspaceId: 'ws', sessionId: 's', imeActive, hasSelection: false });
  return result.kind === 'matched' ? result.action.type : null;
}

test('FR-ARCH-018 AC-1: Alt+Shift+T in a terminal asks for a new tab in every profile, by the physical key', () => {
  assert.equal(actionIn(altShiftT()), 'new-tab');
  assert.equal(actionIn(altShiftT(), tuiState), 'new-tab');
  // Before the settings load, like the other built-ins.
  assert.equal(actionIn(altShiftT(), null), 'new-tab');
  // Hangul mode: the same key reports U+3145.
  assert.equal(actionIn(altShiftT({ key: String.fromCharCode(0x3145) })), 'new-tab');
  assert.equal(actionIn(altShiftT(), state, true), null);
});

test('FR-ARCH-018 AC-1: Alt+T without Shift still toggles the to-do panel, and Ctrl+Alt+Shift+T is not the key', () => {
  assert.equal(actionIn(altShiftT({ key: 't', shiftKey: false })), 'toggle-todo');
  assert.equal(actionIn(altShiftT({ ctrlKey: true })), null);
});

test('FR-ARCH-018 AC-1: the terminal hands the new-tab key to the app and sends nothing to the program', () => {
  const view = readFileSync(new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url), 'utf8');
  assert.match(view, /shortcutResolution\.action\.type === 'new-tab'\) \{\s*ev\.preventDefault\(\);\s*requestNewTab\(\);\s*return false;/u);
});

function windowKey(target: { closest?: (selector: string) => unknown } | null, overrides: Partial<{ isComposing: boolean; defaultPrevented: boolean; repeat: boolean }> = {}, descriptor = altShiftT()) {
  return { ...descriptor, isComposing: false, defaultPrevented: false, repeat: false, target, ...overrides };
}
const sidebar = { closest: () => null };
const insideTerminal = { closest: (selector: string) => (selector === '.xterm' ? {} : null) };

test('FR-ARCH-018 AC-2: outside a terminal Alt+Shift+T asks for a new tab, by the same rule as the to-do key', () => {
  assert.equal(appShortcutForWindowKey(windowKey(sidebar), state), 'new-tab');
  assert.equal(appShortcutForWindowKey(windowKey(null), state), 'new-tab');
  assert.equal(appShortcutForWindowKey(windowKey(sidebar, {}, altShiftT({ key: 't', shiftKey: false })), state), 'toggle-todo');
  // Left to the terminal, which handles its own keys.
  assert.equal(appShortcutForWindowKey(windowKey(insideTerminal), state), null);
  assert.equal(appShortcutForWindowKey(windowKey(sidebar, { isComposing: true }), state), null);
  assert.equal(appShortcutForWindowKey(windowKey(sidebar, { repeat: true }), state), null);
  assert.equal(appShortcutForWindowKey(windowKey(sidebar, { defaultPrevented: true }), state), null);
  assert.equal(appShortcutForWindowKey(windowKey(sidebar, {}, altShiftT({ code: 'KeyY', key: 'Y' })), state), null);
});

test('FR-ARCH-018 AC-2: App routes window keys through appShortcutForWindowKey to the new-tab request', () => {
  const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /appShortcutForWindowKey\(event, terminalShortcutStateRef\.current\)/u);
  assert.match(app, /subscribeNewTabRequests\(/u);
});

test('FR-ARCH-018 AC-3: a user binding on Alt+Shift+T wins, and the action can be bound to another key', () => {
  const passThrough: TerminalShortcutState = {
    ...state,
    bindings: [{
      id: 'u1', scope: 'global', enabled: true, allowRepeat: false, matchByKeyFallback: false, sortOrder: 0, createdAt: now, updatedAt: now,
      key: 'T', code: 'KeyT', ctrlKey: false, shiftKey: true, altKey: true, metaKey: false, location: 0,
      action: { type: 'pass-through' }, description: 'mine',
    }],
  };
  assert.equal(actionIn(altShiftT(), passThrough), null);
  assert.equal(appShortcutForWindowKey(windowKey(sidebar), passThrough), null);

  const ctrlN: TerminalShortcutState = {
    ...state,
    bindings: [{
      id: 'u2', scope: 'global', enabled: true, allowRepeat: false, matchByKeyFallback: false, sortOrder: 0, createdAt: now, updatedAt: now,
      key: 'n', code: 'KeyN', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, location: 0,
      action: { type: 'new-tab' }, description: 'pwa',
    }],
  };
  const ctrlNKey = altShiftT({ key: 'n', code: 'KeyN', ctrlKey: true, shiftKey: false, altKey: false });
  assert.equal(actionIn(ctrlNKey, ctrlN), 'new-tab');
  assert.equal(appShortcutForWindowKey(windowKey(sidebar, {}, ctrlNKey), ctrlN), 'new-tab');
});

test('FR-ARCH-018 AC-3: the shortcut dialog offers and names the new-tab action', () => {
  assert.equal(actionLabel({ type: 'new-tab' }), koCatalog['shortcut.action.newTab']);
  const editor = readFileSync(new URL('../../src/components/TerminalShortcutManager/ShortcutActionEditor.tsx', import.meta.url), 'utf8');
  assert.match(editor, /<option value="new-tab">\{t\('shortcut\.action\.newTab'\)\}<\/option>/u);
});

test('FR-ARCH-018 AC-1: a new tab takes the active tab shell and folder, like the tab bar + button', () => {
  const active = { shellType: 'powershell', cwd: 'C:\\work\\repo' };
  assert.deepEqual(resolveNewTabRequest({ activeTab: active, tabCount: 2, maxTabs: 8 }), { shell: 'powershell', cwd: 'C:\\work\\repo' });
  // The + menu picks a shell: the folder carries over only within the same shell family.
  assert.deepEqual(resolveNewTabRequest({ activeTab: active, tabCount: 2, maxTabs: 8, shell: 'cmd' }), { shell: 'cmd', cwd: 'C:\\work\\repo' });
  assert.deepEqual(resolveNewTabRequest({ activeTab: active, tabCount: 2, maxTabs: 8, shell: 'bash' }), { shell: 'bash', cwd: undefined });
  // No tab yet: the server's defaults.
  assert.deepEqual(resolveNewTabRequest({ activeTab: undefined, tabCount: 0, maxTabs: 8 }), { shell: undefined, cwd: undefined });
});

test('FR-ARCH-018 AC-4: at the tab limit no tab is requested', () => {
  assert.equal(resolveNewTabRequest({ activeTab: { shellType: 'bash', cwd: '/w' }, tabCount: 8, maxTabs: 8 }), null);
  assert.equal(resolveNewTabRequest({ activeTab: { shellType: 'bash', cwd: '/w' }, tabCount: 9, maxTabs: 8 }), null);
});

test('FR-ARCH-018 AC-1: a new-tab request reaches every subscriber until it unsubscribes', () => {
  let calls = 0;
  const off = subscribeNewTabRequests(() => { calls += 1; });
  requestNewTab();
  off();
  requestNewTab();
  assert.equal(calls, 1);
});
