import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createTerminalRedrawScheduler,
  redrawTargetTabIds,
  isTabSwitch,
} from '../../src/utils/terminalRedrawScheduler.ts';
import {
  AUTO_REDRAW_DELAY_DEFAULT_MS,
  readAutoRedrawSettings,
  writeAutoRedrawSettings,
} from '../../src/utils/autoRedrawSettings.ts';
import { resolveTerminalShortcut } from '../../src/utils/terminalShortcutBindings.ts';
import type { TerminalShortcutBinding, TerminalShortcutState } from '../../src/types/index.ts';

// REL-BGSTAB-053: the screen redraw reaches every pane of a grid, runs again on its own a
// moment after a workspace or tab switch, and has a shortcut.

/** Timers the test advances by hand. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn: () => void, ms: number) => { const id = nextId++; pending.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id: unknown) => { pending.delete(id as number); },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
  };
}

// @req REL-BGSTAB-053
test('REL-BGSTAB-053 AC-2: several terminals are redrawn one after another, 100 ms apart', () => {
  const timers = fakeTimers();
  const ran: string[] = [];
  const scheduler = createTerminalRedrawScheduler({ timers, run: (id) => ran.push(id) });
  scheduler.redraw(['a', 'b', 'c']);
  assert.deepEqual(ran, ['a'], 'the first runs at once');
  timers.advance(99);
  assert.deepEqual(ran, ['a']);
  timers.advance(1);
  assert.deepEqual(ran, ['a', 'b']);
  timers.advance(100);
  assert.deepEqual(ran, ['a', 'b', 'c']);
});

// @req REL-BGSTAB-053
test('REL-BGSTAB-053 AC-2: a new request drops what is left of the previous one', () => {
  const timers = fakeTimers();
  const ran: string[] = [];
  const scheduler = createTerminalRedrawScheduler({ timers, run: (id) => ran.push(id) });
  scheduler.redraw(['a', 'b', 'c']);
  scheduler.redraw(['x', 'y']);
  timers.advance(1000);
  assert.deepEqual(ran, ['a', 'x', 'y']);
});

// @req REL-BGSTAB-053
test('REL-BGSTAB-053 AC-3/AC-4: a redraw after a switch waits for the delay; switching again cancels it', () => {
  const timers = fakeTimers();
  const ran: string[] = [];
  const scheduler = createTerminalRedrawScheduler({ timers, run: (id) => ran.push(id) });
  scheduler.redrawAfter(1500, () => ['w1-a', 'w1-b']);
  timers.advance(1000);
  scheduler.redrawAfter(1500, () => ['w2-a']);
  timers.advance(1499);
  assert.deepEqual(ran, [], 'the first switch was cancelled; the second has not come due');
  timers.advance(1);
  assert.deepEqual(ran, ['w2-a'], 'targets are read when the delay ends');
  scheduler.redrawAfter(1500, () => ['w3-a']);
  scheduler.cancel();
  timers.advance(5000);
  assert.deepEqual(ran, ['w2-a']);
});

// @req REL-BGSTAB-053
test('REL-BGSTAB-053 AC-1: the grid redraws every terminal of the workspace; the tab view only the one', () => {
  const tabs = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];
  assert.deepEqual(redrawTargetTabIds({ viewMode: 'grid', tabs, tabId: 't2' }), ['t2', 't1', 't3'], 'the chosen one first');
  assert.deepEqual(redrawTargetTabIds({ viewMode: 'tab', tabs, tabId: 't2' }), ['t2']);
  assert.deepEqual(redrawTargetTabIds({ viewMode: 'grid', tabs, tabId: null }), ['t1', 't2', 't3']);
  assert.deepEqual(redrawTargetTabIds({ viewMode: 'tab', tabs, tabId: null }), []);
});

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    data,
  };
}

// @req REL-BGSTAB-053
test('REL-BGSTAB-053 AC-5: auto redraw is on with 1.5 s by default and kept in this browser', () => {
  assert.equal(AUTO_REDRAW_DELAY_DEFAULT_MS, 1500);
  assert.deepEqual(readAutoRedrawSettings(memoryStorage()), { onWorkspaceSwitch: true, onTabSwitch: true, delayMs: 1500 });
  const storage = memoryStorage();
  writeAutoRedrawSettings(storage, { onWorkspaceSwitch: false, onTabSwitch: true, delayMs: 2500 });
  assert.deepEqual(readAutoRedrawSettings(storage), { onWorkspaceSwitch: false, onTabSwitch: true, delayMs: 2500 });
  writeAutoRedrawSettings(storage, { onWorkspaceSwitch: true, onTabSwitch: false, delayMs: 99_000 });
  assert.equal(readAutoRedrawSettings(storage).delayMs, 5000, 'kept within 0.5-5 s');
  assert.equal(readAutoRedrawSettings(memoryStorage({ 'buildergate.autoRedraw.delayMs': 'nope' })).delayMs, 1500);
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.deepEqual(readAutoRedrawSettings(broken), { onWorkspaceSwitch: true, onTabSwitch: true, delayMs: 1500 }, 'storage that throws gives the defaults');
  writeAutoRedrawSettings(broken, { onWorkspaceSwitch: false, onTabSwitch: false, delayMs: 500 });
});

const ctrlAltR = { key: 'r', code: 'KeyR', ctrlKey: true, shiftKey: false, altKey: true, metaKey: false, location: 0, repeat: false };
const emptyState: TerminalShortcutState = { version: 1, profileSelections: [], bindings: [] } as unknown as TerminalShortcutState;

// @req REL-BGSTAB-053
test('REL-BGSTAB-053 AC-6: Ctrl+Alt+R redraws instead of reaching the terminal, in every profile', () => {
  for (const profile of ['xterm-default', 'ai-tui-compat'] as const) {
    const state = { ...emptyState, profileSelections: [{ scope: 'global', profile, updatedAt: 'x' }] } as unknown as TerminalShortcutState;
    const result = resolveTerminalShortcut({ event: ctrlAltR, state, workspaceId: 'w', sessionId: 's', imeActive: false, hasSelection: false });
    assert.equal(result.kind, 'matched', profile);
    assert.deepEqual(result.kind === 'matched' && result.action, { type: 'redraw' });
  }
  const capitalR = resolveTerminalShortcut({ event: { ...ctrlAltR, key: 'R' }, state: emptyState, workspaceId: 'w', sessionId: 's', imeActive: false, hasSelection: false });
  assert.equal(capitalR.kind, 'matched', 'Caps Lock does not change it');
});

// @req REL-BGSTAB-053
test('REL-BGSTAB-053 AC-6/AC-7: a user binding on Ctrl+Alt+R wins; redraw can be bound to another key', () => {
  const binding = (id: string, key: string, action: TerminalShortcutBinding['action']): TerminalShortcutBinding => ({
    id, scope: 'global', profile: 'xterm-default', key, code: `Key${key.toUpperCase()}`, ctrlKey: true, shiftKey: false, altKey: true, metaKey: false,
    location: 0, action, enabled: true, allowRepeat: false, matchByKeyFallback: false, sortOrder: 0, createdAt: 'x', updatedAt: 'x',
  } as TerminalShortcutBinding);
  const own = { ...emptyState, bindings: [binding('u1', 'r', { type: 'send', data: 'x' })] } as unknown as TerminalShortcutState;
  const mine = resolveTerminalShortcut({ event: ctrlAltR, state: own, workspaceId: 'w', sessionId: 's', imeActive: false, hasSelection: false });
  assert.deepEqual(mine.kind === 'matched' && mine.action, { type: 'send', data: 'x' });
  const moved = { ...emptyState, bindings: [binding('u2', 'd', { type: 'redraw' })] } as unknown as TerminalShortcutState;
  const ctrlAltD = { ...ctrlAltR, key: 'd', code: 'KeyD' };
  const other = resolveTerminalShortcut({ event: ctrlAltD, state: moved, workspaceId: 'w', sessionId: 's', imeActive: false, hasSelection: false });
  assert.deepEqual(other.kind === 'matched' && other.action, { type: 'redraw' });
});

// @req REL-BGSTAB-053
test('REL-BGSTAB-053 AC-6: AltGr+R (Ctrl+Alt on Windows) that types a character is not taken for a redraw', () => {
  const altGr = { ...ctrlAltR, key: '®' };
  const result = resolveTerminalShortcut({ event: altGr, state: emptyState, workspaceId: 'w', sessionId: 's', imeActive: false, hasSelection: false });
  assert.notEqual(result.kind === 'matched' && result.action.type, 'redraw');
});

// @req REL-BGSTAB-053
test('REL-BGSTAB-053 AC-6: Ctrl+Alt+R redraws even before the shortcut settings have loaded', () => {
  const result = resolveTerminalShortcut({ event: ctrlAltR, state: null, workspaceId: 'w', sessionId: 's', imeActive: false, hasSelection: false });
  assert.deepEqual(result.kind === 'matched' && result.action, { type: 'redraw' });
});

// @req REL-BGSTAB-053
test('REL-BGSTAB-053 AC-3/AC-4: only a move between existing tabs counts as a tab switch; creating or closing one does not', () => {
  assert.equal(isTabSwitch({ previousTabId: 'a', tabId: 'b', previousTabIds: ['a', 'b'], tabIds: ['a', 'b'] }), true);
  assert.equal(isTabSwitch({ previousTabId: 'a', tabId: 'c', previousTabIds: ['a', 'b'], tabIds: ['a', 'b', 'c'] }), false, 'a new tab');
  assert.equal(isTabSwitch({ previousTabId: 'a', tabId: 'b', previousTabIds: ['a', 'b'], tabIds: ['b'] }), false, 'the shown tab was closed');
  assert.equal(isTabSwitch({ previousTabId: 'a', tabId: 'a', previousTabIds: ['a'], tabIds: ['a'] }), false);
  assert.equal(isTabSwitch({ previousTabId: null, tabId: 'a', previousTabIds: [], tabIds: ['a'] }), false);
});

// @req REL-BGSTAB-053
test('REL-BGSTAB-053 AC-6: with the Korean IME in Hangul mode the R key (ㄱ) still redraws', () => {
  const hangul = { ...ctrlAltR, key: 'ㄱ' };
  const result = resolveTerminalShortcut({ event: hangul, state: emptyState, workspaceId: 'w', sessionId: 's', imeActive: false, hasSelection: false });
  assert.deepEqual(result.kind === 'matched' && result.action, { type: 'redraw' });
});
