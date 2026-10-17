// FR-MKB-008 / FR-MKB-009 / FR-MKB-010: the special keyboard panel and the
// switch that opens and closes it, rendered under jsdom. Runs through
// test:unit:terminal-view-behavior (tsx + asset stubs) because the components
// import their stylesheet.
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
const { MobileKeyBar, MobileSpecialKeyboard, RIGHT_BLOCK_STORAGE_KEY, useSpecialKeyboardPanel } = await import('../../src/components/MobileKeyboard/index.ts');
const { mobileModifierLatch, sendMobileKeyTo } = await import('../../src/utils/mobileModifierLatch.ts');
type MobileKeyName = import('../../src/utils/mobileKeyEncoder.ts').MobileKeyName;

const ESC = '\u001b';

async function render(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    root,
    cleanup: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

function win(): Window & typeof globalThis {
  return document.defaultView as Window & typeof globalThis;
}

function pointer(target: Element, type: string, x = 0, y = 0): PointerEvent {
  const event = new (win().PointerEvent)(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true,
  });
  target.dispatchEvent(event);
  return event;
}

function mouse(target: Element, type: string): MouseEvent {
  const event = new (win().MouseEvent)(type, { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

async function tap(target: Element): Promise<void> {
  await act(async () => { pointer(target, 'pointerdown', 10, 10); });
  await act(async () => { pointer(target, 'pointerup', 10, 10); });
}

function capOf(cell: Element): string {
  if (cell.hasAttribute('data-special-blank')) return '(blank)';
  return cell.querySelector('.mobile-key__label')?.textContent ?? '';
}

function blockCaps(panel: Element, block: string): string[] {
  const el = panel.querySelector(`[data-special-block="${block}"]`);
  assert.ok(el, `block ${block} is rendered`);
  return [...el.children].map(capOf);
}

function byCap(panel: Element, cap: string): HTMLElement {
  const found = [...panel.querySelectorAll('button')].find(b => b.querySelector('.mobile-key__label')?.textContent === cap);
  assert.ok(found, `button ${cap} is rendered`);
  return found as HTMLElement;
}

test.beforeEach(() => {
  mobileModifierLatch.reset();
  window.localStorage.clear();
});

// --- The switch ---------------------------------------------------------------

interface FakeHandle {
  calls: string[];
  sent: string[];
  blurInput(): void;
  setFocusSuppressed(on: boolean): void;
  focus(reason?: string): void;
  getApplicationCursorKeysMode(): boolean;
  sendInput(data: string): void;
}

function fakeHandle(appCursor = false): FakeHandle {
  const calls: string[] = [];
  const sent: string[] = [];
  return {
    calls,
    sent,
    blurInput: () => { calls.push('blurInput'); },
    setFocusSuppressed: (on: boolean) => { calls.push(`setFocusSuppressed(${on})`); },
    focus: () => { calls.push('focus'); },
    getApplicationCursorKeysMode: () => appCursor,
    sendInput: (data: string) => { sent.push(data); },
  };
}

/**
 * The panel wiring App uses: the real useSpecialKeyboardPanel hook (toggle,
 * close, send, focus hand-back) feeding the bar and the panel the way App
 * renders them. Only the terminal handle is a fake.
 */
function Harness({ handle }: { handle: FakeHandle | null }): React.ReactElement {
  const openRef = useRef(false);
  const panel = useSpecialKeyboardPanel({
    activeTabId: 'tab-1',
    activeSessionId: 'session-1',
    getHandle: () => handle,
    measureHeight: () => 280,
    openRef,
  });
  return React.createElement(
    'div',
    { className: 'column' },
    React.createElement(MobileKeyBar, {
      onSendKey: panel.sendKey,
      onToggleKeyboard: panel.toggle,
      keyboardOpen: panel.open,
      onRestoreFocus: panel.restoreFocus,
    }),
    panel.open ? React.createElement(MobileSpecialKeyboard, { height: panel.height, onSendKey: panel.sendKey }) : null,
  );
}

test('FR-MKB-008 AC-1 / SDS-AC-1: tapping the switch with the system keyboard up blurs the input, suppresses focus and renders the panel', async () => {
  const handle = fakeHandle();
  const view = await render(React.createElement(Harness, { handle }));
  try {
    assert.equal(view.container.querySelector('.mobile-special-keyboard'), null, 'closed at first');
    await tap(view.container.querySelector('[data-mobile-action="toggle-keyboard"]')!);
    assert.deepEqual(handle.calls, ['blurInput', 'setFocusSuppressed(true)']);
    const panel = view.container.querySelector('.mobile-special-keyboard') as HTMLElement | null;
    assert.ok(panel, 'the panel is rendered');
    assert.equal(panel.previousElementSibling?.classList.contains('mobile-key-bar'), true, 'directly below the bar');
    assert.equal(panel.style.height, '280px');
  } finally {
    await view.cleanup();
  }
});

test('FR-MKB-008 AC-3 / SDS-AC-3: tapping the switch with the panel open releases suppression and focuses inside the same pointerup', async () => {
  const handle = fakeHandle();
  const view = await render(React.createElement(Harness, { handle }));
  try {
    const toggle = view.container.querySelector('[data-mobile-action="toggle-keyboard"]')!;
    await tap(toggle);
    handle.calls.length = 0;
    await act(async () => { pointer(toggle, 'pointerdown', 10, 10); });
    // No act around the release: what is recorded right after dispatchEvent
    // returns happened synchronously inside the pointerup handler (iOS only
    // raises the keyboard for a focus() made inside the user gesture).
    pointer(toggle, 'pointerup', 10, 10);
    assert.deepEqual(handle.calls, ['setFocusSuppressed(false)', 'focus'], 'release then focus, synchronously');
    await act(async () => {});
    assert.equal(view.container.querySelector('.mobile-special-keyboard'), null, 'the panel closed');
  } finally {
    await view.cleanup();
  }
});

test('FR-MKB-009 AC-5 / FR-MKB-008 AC-4 / SDS-AC-7: through App\'s panel hook a panel key reaches the active handle in its cursor mode, and nothing refocuses while the panel is open', async () => {
  const handle = fakeHandle(true);
  const view = await render(React.createElement(Harness, { handle }));
  try {
    await tap(view.container.querySelector('[data-mobile-action="toggle-keyboard"]')!);
    const panel = view.container.querySelector('.mobile-special-keyboard');
    assert.ok(panel, 'precondition: the panel is open');
    handle.calls.length = 0;

    await tap(byCap(panel, '↑'));
    await tap(byCap(panel, 'F1'));
    await tap(byCap(panel, '/'));
    assert.deepEqual(handle.sent, [`${ESC}OA`, `${ESC}OP`, '/'], 'application cursor mode is read from the active handle');

    // A bar key tapped while a bar button holds focus: with the panel closed
    // this hands focus back to the terminal; with it open it must not.
    const esc = view.container.querySelector('.mobile-key-bar [data-mobile-key="Esc"]') as HTMLButtonElement;
    await act(async () => { esc.focus(); });
    await tap(esc);
    assert.equal(handle.sent.at(-1), ESC);
    assert.deepEqual(handle.calls, [], 'no focus() and no other handle call while the panel is open');
  } finally {
    await view.cleanup();
  }
});

test('FR-MKB-008 AC-1 AC-4: with no terminal handle attached the switch does not open the panel, so no unsuppressed terminal sits under it', async () => {
  const view = await render(React.createElement(Harness, { handle: null }));
  try {
    await tap(view.container.querySelector('[data-mobile-action="toggle-keyboard"]')!);
    assert.equal(view.container.querySelector('.mobile-special-keyboard'), null, 'the panel stays closed');
    assert.equal(view.container.querySelector('[data-mobile-action="toggle-keyboard"]')!.getAttribute('aria-pressed'), 'false');

    // Once the handle is there, the same switch opens it with suppression.
    const handle = fakeHandle();
    await act(async () => { view.root.render(React.createElement(Harness, { handle })); });
    await tap(view.container.querySelector('[data-mobile-action="toggle-keyboard"]')!);
    assert.ok(view.container.querySelector('.mobile-special-keyboard'), 'the panel opens');
    assert.deepEqual(handle.calls, ['blurInput', 'setFocusSuppressed(true)']);
  } finally {
    await view.cleanup();
  }
});

test('FR-MKB-009 AC-6 / FR-MKB-006 AC-4: a long press on a panel key, the panel or a bar key does not open the context menu', async () => {
  const handle = fakeHandle();
  const view = await render(React.createElement(Harness, { handle }));
  try {
    await tap(view.container.querySelector('[data-mobile-action="toggle-keyboard"]')!);
    const panel = view.container.querySelector('.mobile-special-keyboard')!;
    const bar = view.container.querySelector('.mobile-key-bar')!;
    for (const target of [byCap(panel, 'F1'), byCap(panel, '/'), panel, bar.querySelector('[data-mobile-key="Esc"]')!, bar]) {
      const event = mouse(target, 'contextmenu');
      assert.equal(event.defaultPrevented, true, `contextmenu on ${target.className} is prevented`);
    }
  } finally {
    await view.cleanup();
  }
});

test('FR-MKB-008 AC-5 / SDS-AC-5: with the panel open the switch reads ABC and offers the way back to the system keyboard', async () => {
  const view = await render(React.createElement(MobileKeyBar, { onSendKey: () => {}, onToggleKeyboard: () => {}, keyboardOpen: true }));
  try {
    const toggle = view.container.querySelector('[data-mobile-action="toggle-keyboard"]')!;
    assert.match(toggle.textContent ?? '', /ABC$/);
    assert.equal(toggle.getAttribute('aria-label'), en['mobileKeyboard.switch.toSystem']);
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  } finally {
    await view.cleanup();
  }
});

test('FR-MKB-008 AC-4 / SDS-AC-5: with the panel open the bar does not hand focus back to the terminal', async () => {
  let restores = 0;
  const view = await render(React.createElement(MobileKeyBar, {
    onSendKey: () => {}, onToggleKeyboard: () => {}, keyboardOpen: true, onRestoreFocus: () => { restores += 1; },
  }));
  try {
    const esc = [...view.container.querySelectorAll('button')].find(b => b.textContent === 'Esc') as HTMLButtonElement;
    await act(async () => { esc.focus(); });
    await tap(esc);
    assert.equal(restores, 0, 'no hand-back while the panel owns the keyboard area');
  } finally {
    await view.cleanup();
  }
});

// --- The panel ----------------------------------------------------------------

test('FR-MKB-009 AC-1 AC-2 AC-3 AC-4 / SDS-AC-6: the panel renders the top row and the three blocks in order', async () => {
  const view = await render(React.createElement(MobileSpecialKeyboard, { height: 300, onSendKey: () => {} }));
  try {
    const panel = view.container.querySelector('.mobile-special-keyboard')!;
    assert.deepEqual(blockCaps(panel, 'top'), ['Esc', 'Tab', 'Ctrl', 'Alt', 'Shift']);
    assert.equal(panel.querySelectorAll('[data-special-block="top"] [data-latch-state]').length, 3, 'Ctrl, Alt and Shift are LatchKeys');
    assert.deepEqual(blockCaps(panel, 'left'), ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']);
    assert.deepEqual(blockCaps(panel, 'middle'), ['⌫', '/', '|', '~', '*', '-', '`', ':', '+', '_', '=', 'Enter']);
    assert.deepEqual(blockCaps(panel, 'right'), [
      'Home', '↑', 'PgUp', '←', '(blank)', '→', 'End', '↓', 'PgDn', 'Ins', 'Del', en['mobileKeyboard.special.numpadLabel'],
    ]);
    for (const arrow of ['↑', '←', '→', '↓']) {
      assert.ok(byCap(panel, arrow).classList.contains('mobile-special-key--arrow'), `${arrow} stands out`);
    }
    assert.equal((panel as HTMLElement).style.height, '300px');
    const all = panel.textContent ?? '';
    for (const banned of ['Win', 'AltGr', 'Mouse', 'Screenshot']) assert.ok(!all.includes(banned), `no ${banned}`);
  } finally {
    await view.cleanup();
  }
});

test('FR-MKB-009 AC-5 / SDS-AC-7: F5 after one Alt tap sends ESC ESC [15~ and Alt is spent', async () => {
  const sent: string[] = [];
  const target = { getApplicationCursorKeysMode: () => false, sendInput: (data: string) => { sent.push(data); } };
  const view = await render(React.createElement(MobileSpecialKeyboard, {
    height: 280,
    onSendKey: (key: MobileKeyName | string) => { sendMobileKeyTo(target, key as MobileKeyName); },
  }));
  try {
    const panel = view.container.querySelector('.mobile-special-keyboard')!;
    await tap(panel.querySelector('[data-mod="alt"]')!);
    assert.equal(mobileModifierLatch.getSnapshot().alt, 'once');
    await tap(byCap(panel, 'F5'));
    assert.deepEqual(sent, [`${ESC}${ESC}[15~`]);
    assert.equal(mobileModifierLatch.getSnapshot().alt, 'off', 'the once modifier is spent');

    await tap(byCap(panel, '|'));
    await tap(byCap(panel, '⌫'));
    await tap(byCap(panel, 'Enter'));
    assert.deepEqual(sent.slice(1), ['|', '\x7f', '\r'], 'characters and named keys go through the encoder');
  } finally {
    await view.cleanup();
  }
});

test('FR-MKB-009 AC-6: panel keys act on pointerup, prevent focus-moving defaults and ignore an 8 px drag', async () => {
  const sent: string[] = [];
  const view = await render(React.createElement(MobileSpecialKeyboard, { height: 280, onSendKey: (key: string) => { sent.push(key); } }));
  try {
    const panel = view.container.querySelector('.mobile-special-keyboard')!;
    const f1 = byCap(panel, 'F1');
    let down!: PointerEvent;
    let mdown!: MouseEvent;
    await act(async () => { down = pointer(f1, 'pointerdown', 10, 10); mdown = mouse(f1, 'mousedown'); });
    assert.equal(down.defaultPrevented, true);
    assert.equal(mdown.defaultPrevented, true);
    assert.deepEqual(sent, [], 'nothing on pointerdown');
    await act(async () => { pointer(f1, 'pointermove', 30, 10); });
    await act(async () => { pointer(f1, 'pointerup', 30, 10); });
    assert.deepEqual(sent, [], 'a drag sends nothing');
    await tap(f1);
    assert.deepEqual(sent, ['F1']);
  } finally {
    await view.cleanup();
  }
});

test('FR-MKB-010 AC-1 AC-2 AC-4 / SDS-AC-8: Numpad swaps only the right block, keeps the other keys in place, and is remembered', async () => {
  const sent: string[] = [];
  const view = await render(React.createElement(MobileSpecialKeyboard, { height: 280, onSendKey: (key: string) => { sent.push(key); } }));
  try {
    const panel = view.container.querySelector('.mobile-special-keyboard')!;
    const leftBefore = [...panel.querySelector('[data-special-block="left"]')!.children];
    const middleBefore = [...panel.querySelector('[data-special-block="middle"]')!.children];
    const topBefore = [...panel.querySelector('[data-special-block="top"]')!.children];

    await tap(panel.querySelector('[data-special-switch="numpad"]')!);
    assert.deepEqual(blockCaps(panel, 'right'), ['7', '8', '9', '4', '5', '6', '1', '2', '3', '0', '.', en['mobileKeyboard.special.arrowsLabel']]);
    // deepEqual cannot tell two jsdom elements apart, so identity is checked
    // node by node, and the caps are compared as text.
    for (const [block, before] of [['left', leftBefore], ['middle', middleBefore], ['top', topBefore]] as const) {
      const after = [...panel.querySelector(`[data-special-block="${block}"]`)!.children];
      assert.equal(after.length, before.length, `${block} keeps its key count`);
      after.forEach((node, i) => assert.strictEqual(node, before[i], `${block} key ${i} is the same node in the same place`));
    }
    assert.deepEqual(blockCaps(panel, 'left'), ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']);
    assert.deepEqual(blockCaps(panel, 'middle'), ['⌫', '/', '|', '~', '*', '-', '`', ':', '+', '_', '=', 'Enter']);
    assert.equal(window.localStorage.getItem(RIGHT_BLOCK_STORAGE_KEY), 'numpad');
    assert.deepEqual(sent, [], 'the block switch sends nothing');

    await tap(byCap(panel, '7'));
    await tap(byCap(panel, '.'));
    assert.deepEqual(sent, ['7', '.']);
  } finally {
    await view.cleanup();
  }

  // The next panel opens on the remembered block, and Arrows brings the arrows back.
  const again = await render(React.createElement(MobileSpecialKeyboard, { height: 280, onSendKey: () => {} }));
  try {
    const panel = again.container.querySelector('.mobile-special-keyboard')!;
    assert.equal(blockCaps(panel, 'right')[0], '7', 'opens on the numpad');
    await tap(panel.querySelector('[data-special-switch="arrows"]')!);
    assert.equal(blockCaps(panel, 'right')[0], 'Home');
    assert.equal(window.localStorage.getItem(RIGHT_BLOCK_STORAGE_KEY), 'arrows');
  } finally {
    await again.cleanup();
  }
});

test('FR-MKB-009 AC-7: every panel aria label comes from the catalog and follows the active language', async () => {
  const view = await render(React.createElement(MobileSpecialKeyboard, { height: 280, onSendKey: () => {} }));
  try {
    const panel = view.container.querySelector('.mobile-special-keyboard')!;
    assert.equal(panel.getAttribute('aria-label'), en['mobileKeyboard.special.panel']);
    for (const button of panel.querySelectorAll('button')) {
      const aria = button.getAttribute('aria-label') ?? '';
      assert.ok(aria.length > 0, `${button.textContent} has an aria label`);
      assert.equal(button.getAttribute('title'), aria);
    }
    assert.equal(byCap(panel, 'F5').getAttribute('aria-label'), en['mobileKeyboard.key.function'].replace('{name}', 'F5'));
  } finally {
    await view.cleanup();
  }
  installCatalog('ko', ko);
  const koView = await render(React.createElement(MobileSpecialKeyboard, { height: 280, onSendKey: () => {} }));
  try {
    const panel = koView.container.querySelector('.mobile-special-keyboard')!;
    assert.equal(panel.getAttribute('aria-label'), ko['mobileKeyboard.special.panel']);
    assert.equal(byCap(panel, 'Enter').getAttribute('aria-label'), ko['mobileKeyboard.key.enter']);
  } finally {
    await koView.cleanup();
    installCatalog('en', en);
  }
});

// The tests above render App's own panel hook (useSpecialKeyboardPanel),
// because rendering App needs the whole application. What ties App to that
// hook is read from its source: the hook call with the shared open ref, the
// same visibility input, the same height rule, the panel right under the bar,
// and the close on leaving mobile mode.
test('FR-MKB-008 AC-1 AC-2 AC-3 AC-5 AC-6 / SDS-AC-1 SDS-AC-2 SDS-AC-3 SDS-AC-5: App wires the switch, the height, the bar visibility and the panel the way the harness does', () => {
  const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  const model = readFileSync(new URL('../../src/components/MobileKeyboard/mobileKeyboardModel.ts', import.meta.url), 'utf8');
  assert.match(model, /applySpecialKeyboardToggle\(\s*openRef\.current\s*,/, 'the toggle reads the open state from a ref, not a state updater');
  assert.match(app, /useSpecialKeyboardPanel\(\{[^}]*openRef:\s*specialKeyboardOpenRef/, 'App wires the panel through the hook rendered above, sharing its open ref with the focus paths');
  assert.match(app, /onSendKey=\{specialKeyboard\.sendKey\}\s*onToggleKeyboard=\{specialKeyboard\.toggle\}/, 'the bar sends and toggles through the hook');
  assert.match(app, /<MobileSpecialKeyboard height=\{specialKeyboardHeight\} onSendKey=\{specialKeyboard\.sendKey\}/, 'the panel sends through the hook');
  assert.match(app, /specialPanelHeight\(\s*getLastKeyboardInset\(\)\s*\)/, 'the panel height is the last inset or 280');
  assert.match(app, /panelOpen:\s*specialKeyboardOpen/, 'the bar stays visible while the panel is open');
  assert.match(app, /keyboardOpen=\{specialKeyboardOpen\}/, 'the switch shows ABC while the panel is open');
  const bar = app.indexOf('<MobileKeyBar');
  const panel = app.indexOf('<MobileSpecialKeyboard');
  assert.ok(bar > 0 && panel > bar, 'the panel is mounted after the bar');
  const between = app.slice(bar, panel);
  assert.equal((between.match(/<\/div>/g) ?? []).length, 0, 'no container closes between the bar and the panel: same flex column');
  assert.match(app, /if\s*\(\s*!isMobile\s*\)\s*closeSpecialKeyboard\(\)/, 'the panel closes when mobile mode ends');
});

test('FR-MKB-009 AC-6: panel keys are at least the 44 px touch size', () => {
  const css = readFileSync(new URL('../../src/components/MobileKeyboard/mobileKeyboard.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(m => m[1].trim() === '.mobile-special-key');
  assert.ok(rule, 'one rule for .mobile-special-key');
  assert.match(rule[2], /min-height:\s*var\(--ctl-touch\)/);
  assert.match(rule[2], /-webkit-touch-callout:\s*none/, 'a long press shows no callout');
});
