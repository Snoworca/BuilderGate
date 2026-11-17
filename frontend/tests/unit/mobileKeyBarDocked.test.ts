// FR-MKB-013 AC-6: on a touch device, while the active terminal's program tracks
// the mouse (Claude Code showing choices) and the system keyboard is down, the key
// bar docks at the bottom of the screen. Its keys reach the program without raising
// the keyboard, and its keyboard button raises it. A tap on a choice no longer
// raises the keyboard (FR-ARCH-010 AC-8), so before this the arrow keys could not
// be reached to go back to a previous choice.
// Runs through test:unit:terminal-view-behavior (tsx + asset stubs): the bar
// imports its stylesheet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installJsdomEnvironment } from './jsdomEnvironment.ts';

installJsdomEnvironment();
const en = JSON.parse(readFileSync(new URL('../../public/locales/messages.en.json', import.meta.url), 'utf8')) as Record<string, string>;
const ko = JSON.parse(readFileSync(new URL('../../public/locales/messages.ko.json', import.meta.url), 'utf8')) as Record<string, string>;
const { installCatalog } = await import('../../src/i18n/i18n.ts');
installCatalog('en', en);
const React = await import('react');
const { act, useRef } = React;
const { createRoot } = await import('react-dom/client');
const {
  MobileKeyBar,
  MOUSE_TRACKING_POLL_MS,
  shouldDockMobileKeyBar,
  useActiveTerminalMouseTracking,
  useSpecialKeyboardPanel,
} = await import('../../src/components/MobileKeyboard/index.ts');
const { mobileModifierLatch } = await import('../../src/utils/mobileModifierLatch.ts');

const ESC = '\u001b';

function win(): Window & typeof globalThis {
  return document.defaultView as Window & typeof globalThis;
}

function pointer(target: Element, type: string): void {
  target.dispatchEvent(new (win().PointerEvent)(type, {
    bubbles: true, cancelable: true, clientX: 10, clientY: 10, pointerId: 1, isPrimary: true,
  }));
}

async function tap(target: Element): Promise<void> {
  await act(async () => { pointer(target, 'pointerdown'); });
  await act(async () => { pointer(target, 'pointerup'); });
}

async function render(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    rerender: (next: React.ReactElement) => act(async () => { root.render(next); }),
    cleanup: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

/** Drops block and line comments so a commented-out call does not count as wiring. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

interface FakeHandle {
  calls: string[];
  sent: string[];
  mouseTracking: boolean;
  blurInput(): void;
  setFocusSuppressed(on: boolean): void;
  focus(): void;
  getApplicationCursorKeysMode(): boolean;
  getMouseTrackingActive(): boolean;
  sendInput(data: string): void;
}

function fakeHandle(mouseTracking = true): FakeHandle {
  const handle: FakeHandle = {
    calls: [],
    sent: [],
    mouseTracking,
    blurInput: () => { handle.calls.push('blurInput'); },
    setFocusSuppressed: (on: boolean) => { handle.calls.push(`setFocusSuppressed(${on})`); },
    focus: () => { handle.calls.push('focus'); },
    getApplicationCursorKeysMode: () => false,
    getMouseTrackingActive: () => handle.mouseTracking,
    sendInput: (data: string) => { handle.sent.push(data); },
  };
  return handle;
}

/** The docked bar wired the way App wires it: the real panel hook, a fake terminal handle. */
function DockedHarness({ handle }: { handle: FakeHandle }): React.ReactElement {
  const openRef = useRef(false);
  const panel = useSpecialKeyboardPanel({
    activeTabId: 'tab-1',
    activeSessionId: 'session-1',
    getHandle: () => handle,
    measureHeight: () => 280,
    openRef,
  });
  return React.createElement(MobileKeyBar, {
    docked: true,
    onSendKey: panel.sendKeyWithoutFocus,
    onToggleKeyboard: panel.restoreFocus,
    keyboardOpen: false,
  });
}

test.beforeEach(() => {
  mobileModifierLatch.reset();
});

test('FR-MKB-013 AC-6: the bar docks on a touch device while the program tracks the mouse and the keyboard is down', () => {
  const base = { isTouchInput: true, screen: 'workspace', hasActiveTab: true, mouseTracking: true, keyboardUp: false, keyBarShown: false };
  assert.equal(shouldDockMobileKeyBar(base), true);
  assert.equal(shouldDockMobileKeyBar({ ...base, mouseTracking: false }), false, 'a plain shell keeps today\'s behavior');
  assert.equal(shouldDockMobileKeyBar({ ...base, keyboardUp: true }), false, 'with the keyboard up the bar sits above it instead');
  assert.equal(shouldDockMobileKeyBar({ ...base, keyBarShown: true }), false, 'never two bars');
  assert.equal(shouldDockMobileKeyBar({ ...base, isTouchInput: false }), false, 'never on a desktop');
  assert.equal(shouldDockMobileKeyBar({ ...base, screen: 'settings' }), false);
  assert.equal(shouldDockMobileKeyBar({ ...base, hasActiveTab: false }), false);
});

test('FR-MKB-013 AC-6: a docked arrow reaches the program and does not focus the terminal', async () => {
  const handle = fakeHandle();
  const view = await render(React.createElement(DockedHarness, { handle }));
  try {
    const up = view.container.querySelector('[data-mobile-key="Up"]');
    assert.ok(up, 'the docked bar has the arrow keys');
    await tap(up);
    assert.deepEqual(handle.sent, [`${ESC}[A`]);
    assert.equal(handle.calls.includes('focus'), false, 'no focus, so the keyboard stays down');
  } finally {
    await view.cleanup();
  }
});

test('FR-MKB-013 AC-6: the docked keyboard button raises the system keyboard by focusing the terminal', async () => {
  const handle = fakeHandle();
  const view = await render(React.createElement(DockedHarness, { handle }));
  try {
    const button = view.container.querySelector('[data-mobile-action="toggle-keyboard"]');
    assert.ok(button);
    assert.equal(button.getAttribute('aria-label'), en['mobileKeyboard.switch.showKeyboard']);
    assert.match(button.textContent ?? '', new RegExp(en['mobileKeyboard.switch.keyboardLabel']));
    await tap(button);
    assert.deepEqual(handle.calls, ['focus'], 'focus only: the special panel does not open');
    assert.deepEqual(handle.sent, []);
  } finally {
    await view.cleanup();
  }
});

test('FR-MKB-013 AC-6: the docked keyboard button is labelled from the catalog in en and ko', () => {
  for (const key of ['mobileKeyboard.switch.showKeyboard', 'mobileKeyboard.switch.keyboardLabel']) {
    assert.ok(en[key], `${key} in en`);
    assert.ok(ko[key], `${key} in ko`);
  }
});

test('FR-MKB-013 AC-6: the mouse tracking of the active tab is read again on a poll and on a tab change', async () => {
  const handles: Record<string, FakeHandle> = { a: fakeHandle(false), b: fakeHandle(true) };
  const seen: boolean[] = [];
  function Probe({ tabId, enabled }: { tabId: string | null; enabled: boolean }): null {
    seen.push(useActiveTerminalMouseTracking(tabId, enabled, (id: string) => handles[id] ?? null));
    return null;
  }
  const view = await render(React.createElement(Probe, { tabId: 'a', enabled: true }));
  const wait = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
  try {
    assert.equal(seen.at(-1), false);
    await view.rerender(React.createElement(Probe, { tabId: 'b', enabled: true }));
    assert.equal(seen.at(-1), true, 'a tab change reads the new tab at once');
    handles.b.mouseTracking = false;
    await wait(MOUSE_TRACKING_POLL_MS + 100);
    assert.equal(seen.at(-1), false, 'the poll picks up the program leaving mouse mode');
    const renders = seen.length;
    await wait(MOUSE_TRACKING_POLL_MS * 2 + 100);
    assert.equal(seen.length, renders, 'an unchanged value does not re-render');
    await view.rerender(React.createElement(Probe, { tabId: 'b', enabled: false }));
    handles.b.mouseTracking = true;
    await wait(MOUSE_TRACKING_POLL_MS + 100);
    assert.equal(seen.at(-1), false, 'disabled (a desktop) reads nothing and answers false');
  } finally {
    await view.cleanup();
  }
});

test('FR-MKB-013 AC-6: App docks the bar with the hook\'s focus-free send and the keyboard button, without the viewport lock', () => {
  const app = stripComments(readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8'));
  assert.match(app, /useActiveTerminalMouseTracking\(\s*activeTabId\s*,\s*isTouchInput\s*,\s*getTerminalHandle\s*\)/);
  assert.match(app, /shouldDockMobileKeyBar\(\{[^}]*keyboardUp:\s*systemKeyboardUp[^}]*keyBarShown:\s*showMobileKeyBar[^}]*\}\)/);
  assert.match(
    app,
    /<MobileKeyBar\s+docked\s+onSendKey=\{specialKeyboard\.sendKeyWithoutFocus\}\s+onToggleKeyboard=\{specialKeyboard\.restoreFocus\}\s+keyboardOpen=\{false\}/,
  );
  assert.match(app, /useVisualViewportLock\(\s*showMobileKeyBar\s*,/, 'the docked bar does not lock the app to the visual viewport');
});
