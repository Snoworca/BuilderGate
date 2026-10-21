// FR-MKB-005 / FR-MKB-006: the mobile accessory key bar and its lockable
// Ctrl/Alt/Shift buttons, rendered under jsdom. Runs through
// test:unit:terminal-view-behavior (tsx + asset stubs) because the components
// import their stylesheet.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installJsdomEnvironment } from './jsdomEnvironment.ts';

installJsdomEnvironment();

const en = JSON.parse(readFileSync(new URL('../../public/locales/messages.en.json', import.meta.url), 'utf8')) as Record<string, string>;
const ko = JSON.parse(readFileSync(new URL('../../public/locales/messages.ko.json', import.meta.url), 'utf8')) as Record<string, string>;

const { installCatalog } = await import('../../src/i18n/i18n.ts');
installCatalog('en', en);

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { LatchKey, MobileKeyBar, MOBILE_BAR_KEYS, shouldShowMobileKeyBar, useResetLatchWhenNotMobile } = await import('../../src/components/MobileKeyboard/index.ts');
const { useTerminalInputFocus } = await import('../../src/hooks/useTerminalInputFocus.ts');
const { mobileModifierLatch, LATCH_HOLD_MS } = await import('../../src/utils/mobileModifierLatch.ts');

type Root = ReturnType<typeof createRoot>;

async function render(element: React.ReactElement): Promise<{ container: HTMLElement; root: Root; cleanup: () => Promise<void> }> {
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

test.beforeEach(() => {
  mobileModifierLatch.reset();
});

// --- LatchKey -----------------------------------------------------------------

test('FR-MKB-005 AC-1 AC-6 / SDS-AC-1: LatchKey exposes data-latch-state for off, once and locked, with a corner dot', async () => {
  const view = await render(React.createElement(LatchKey, { mod: 'ctrl', label: 'Ctrl', ariaLabel: 'Control' }));
  try {
    const button = view.container.querySelector('button')!;
    assert.equal(button.getAttribute('data-latch-state'), 'off');
    assert.ok(button.querySelector('.mobile-key__dot'), 'the lockable key carries a corner dot');
    assert.equal(button.getAttribute('aria-label'), 'Control');

    await act(async () => { mobileModifierLatch.tap('ctrl'); });
    assert.equal(button.getAttribute('data-latch-state'), 'once', 'a change made elsewhere is drawn');

    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await act(async () => { mobileModifierLatch.tap('ctrl'); });
      await act(async () => {
        mobileModifierLatch.startPress('ctrl');
        mock.timers.tick(LATCH_HOLD_MS);
      });
    } finally {
      mock.timers.reset();
    }
    assert.equal(button.getAttribute('data-latch-state'), 'locked');
  } finally {
    await view.cleanup();
  }
});

test('FR-MKB-005 AC-1 / SDS-AC-1: in the bar only Ctrl and Alt carry a dot; plain keys do not', async () => {
  const view = await render(React.createElement(MobileKeyBar, {
    onSendKey: () => {}, onToggleKeyboard: () => {}, keyboardOpen: false,
  }));
  try {
    const withDot = [...view.container.querySelectorAll('button')]
      .filter(b => b.querySelector('.mobile-key__dot'))
      .map(b => b.textContent?.trim());
    assert.deepEqual(withDot, ['Ctrl', 'Alt']);
    const latchStates = [...view.container.querySelectorAll('[data-latch-state]')].length;
    assert.equal(latchStates, 2, 'only the lockable keys report a latch state');
  } finally {
    await view.cleanup();
  }
});

test('FR-MKB-005 AC-3 AC-4 / SDS-AC-2: pointerdown then pointerup before 1500 ms leaves the modifier once', async () => {
  const view = await render(React.createElement(LatchKey, { mod: 'alt', label: 'Alt', ariaLabel: 'Alt' }));
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const button = view.container.querySelector('button')!;
    let down!: PointerEvent;
    await act(async () => { down = pointer(button, 'pointerdown'); });
    assert.equal(down.defaultPrevented, true, 'pointerdown default is prevented so focus stays');
    assert.ok(button.classList.contains('mobile-key--holding'), 'the hold fill runs while pressed');
    await act(async () => { mock.timers.tick(LATCH_HOLD_MS - 1); });
    await act(async () => { pointer(button, 'pointerup'); });
    assert.equal(mobileModifierLatch.getSnapshot().alt, 'once');
    assert.equal(button.classList.contains('mobile-key--holding'), false, 'the fill is gone after release');
  } finally {
    mock.timers.reset();
    await view.cleanup();
  }
});

test('FR-MKB-005 AC-3 / SDS-AC-2: pointercancel leaves the modifier unchanged, and a held press locks', async () => {
  const view = await render(React.createElement(LatchKey, { mod: 'shift', label: 'Shift', ariaLabel: 'Shift' }));
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const button = view.container.querySelector('button')!;
    await act(async () => { pointer(button, 'pointerdown'); });
    await act(async () => { pointer(button, 'pointercancel'); });
    await act(async () => { mock.timers.tick(LATCH_HOLD_MS * 2); });
    assert.equal(mobileModifierLatch.getSnapshot().shift, 'off', 'cancel neither taps nor locks');

    await act(async () => { pointer(button, 'pointerdown'); });
    await act(async () => { mock.timers.tick(LATCH_HOLD_MS); });
    assert.equal(mobileModifierLatch.getSnapshot().shift, 'locked');
    assert.equal(button.classList.contains('mobile-key--holding'), false, 'the fill is gone once locked');
    await act(async () => { pointer(button, 'pointerup'); });
    assert.equal(mobileModifierLatch.getSnapshot().shift, 'locked', 'the release after a lock is not a tap');

    // Released outside the button: the lost capture ends the press without a lock.
    await act(async () => { mobileModifierLatch.reset(); });
    await act(async () => { pointer(button, 'pointerdown'); });
    await act(async () => { pointer(button, 'lostpointercapture'); });
    await act(async () => { mock.timers.tick(LATCH_HOLD_MS * 2); });
    assert.equal(mobileModifierLatch.getSnapshot().shift, 'off', 'a press that lost its pointer never locks');
    assert.equal(button.classList.contains('mobile-key--holding'), false);
  } finally {
    mock.timers.reset();
    await view.cleanup();
  }
});

test('FR-MKB-005 AC-5 / SDS-AC-3: contextmenu on a LatchKey is prevented and does not reach a parent listener', async () => {
  let parentSaw = 0;
  const view = await render(React.createElement(
    'div',
    { onContextMenu: () => { parentSaw += 1; } },
    React.createElement(LatchKey, { mod: 'ctrl', label: 'Ctrl', ariaLabel: 'Control' }),
  ));
  // On document.body, outside the React root: a listener on the root container
  // itself would still run after stopPropagation inside a React handler.
  const nativeParent = () => { parentSaw += 1; };
  document.body.addEventListener('contextmenu', nativeParent);
  try {
    const button = view.container.querySelector('button')!;
    let event!: MouseEvent;
    await act(async () => { event = mouse(button, 'contextmenu'); });
    assert.equal(event.defaultPrevented, true);
    assert.equal(parentSaw, 0, 'stopPropagation keeps the long-press menu from the terminal host');
  } finally {
    document.body.removeEventListener('contextmenu', nativeParent);
    await view.cleanup();
  }
});

// --- MobileKeyBar -------------------------------------------------------------

test('FR-MKB-006 AC-1 / SDS-AC-4: the bar lists its keys in MOBILE_BAR_KEYS order plus the switch button', async () => {
  const view = await render(React.createElement(MobileKeyBar, {
    onSendKey: () => {}, onToggleKeyboard: () => {}, keyboardOpen: false,
  }));
  try {
    const labels = [...view.container.querySelectorAll('button, [data-mobile-sep]')]
      .map(el => (el.hasAttribute('data-mobile-sep') ? '|' : el.querySelector('.mobile-key__label')?.textContent ?? ''));
    assert.deepEqual(labels.slice(0, -1), [
      'Esc', 'Tab', 'Ctrl', 'Alt', '|',
      '←', '↑', '↓', '→', '|',
      'Home', 'End', 'PgUp', 'PgDn',
    ]);
    const last = [...view.container.querySelectorAll('button')].at(-1)!;
    assert.equal(last.getAttribute('data-mobile-action'), 'toggle-keyboard', 'the switch button is last');

    const order = MOBILE_BAR_KEYS.map(entry => (entry.kind === 'sep' ? '|' : entry.label));
    assert.deepEqual(order, labels.slice(0, -1), 'render order is the table order');

    const all = view.container.textContent ?? '';
    for (const banned of ['Win', 'AltGr', 'Mouse', 'Screenshot']) {
      assert.ok(!all.includes(banned), `no ${banned} key`);
    }
  } finally {
    await view.cleanup();
  }
});

test('FR-MKB-006 AC-1 AC-4 / SDS-AC-4: a tap sends the key name on pointerup; the switch calls onToggleKeyboard', async () => {
  const sent: string[] = [];
  let toggles = 0;
  const view = await render(React.createElement(MobileKeyBar, {
    onSendKey: (key: string) => { sent.push(key); }, onToggleKeyboard: () => { toggles += 1; }, keyboardOpen: false,
  }));
  try {
    const byLabel = (text: string) => [...view.container.querySelectorAll('button')]
      .find(b => b.querySelector('.mobile-key__label')?.textContent === text)!;
    for (const [label, name] of [['Esc', 'Esc'], ['↑', 'Up'], ['PgDn', 'PageDown']] as const) {
      const button = byLabel(label);
      const before = sent.length;
      await act(async () => { pointer(button, 'pointerdown', 10, 10); });
      assert.equal(sent.length, before, 'nothing is sent on pointerdown');
      await act(async () => { pointer(button, 'pointerup', 12, 11); });
      assert.equal(sent.at(-1), name);
    }
    assert.deepEqual(sent, ['Esc', 'Up', 'PageDown']);

    const toggle = view.container.querySelector('[data-mobile-action="toggle-keyboard"]')!;
    await act(async () => { pointer(toggle, 'pointerdown', 5, 5); });
    await act(async () => { pointer(toggle, 'pointerup', 5, 5); });
    assert.equal(toggles, 1);
    assert.deepEqual(sent, ['Esc', 'Up', 'PageDown'], 'the switch sends no key');
  } finally {
    await view.cleanup();
  }
});

test('FR-MKB-006 AC-4 / SDS-AC-6: pressing a bar key keeps the helper textarea focused, and a 20 px drag sends nothing', async () => {
  const host = document.createElement('div');
  host.setAttribute('data-tab-id', 'tab-a');
  const textarea = document.createElement('textarea');
  textarea.className = 'xterm-helper-textarea';
  host.appendChild(textarea);
  document.body.appendChild(host);
  textarea.focus();

  const sent: string[] = [];
  const view = await render(React.createElement(MobileKeyBar, {
    onSendKey: (key: string) => { sent.push(key); }, onToggleKeyboard: () => {}, keyboardOpen: false,
  }));
  try {
    const bar = view.container.querySelector('.mobile-key-bar') as HTMLElement;
    assert.equal(bar.style.touchAction, 'pan-x', 'the bar only allows horizontal panning');

    const tab = [...view.container.querySelectorAll('button')]
      .find(b => b.querySelector('.mobile-key__label')?.textContent === 'Tab')!;
    let down!: PointerEvent;
    let mdown!: MouseEvent;
    await act(async () => {
      down = pointer(tab, 'pointerdown', 40, 10);
      mdown = mouse(tab, 'mousedown');
    });
    assert.equal(down.defaultPrevented, true, 'pointerdown default prevented');
    assert.equal(mdown.defaultPrevented, true, 'mousedown default prevented');
    // jsdom never moves focus on a synthetic pointerdown/mousedown, so this line
    // holds regardless; the defaultPrevented assertions above carry the contract
    // and the real focus behaviour is left to a browser run.
    assert.equal(document.activeElement, textarea, 'the helper textarea stays focused');

    await act(async () => { pointer(tab, 'pointermove', 60, 10); });
    await act(async () => { pointer(tab, 'pointerup', 60, 10); });
    assert.deepEqual(sent, [], 'a horizontal drag is a scroll, not a key');

    await act(async () => { pointer(tab, 'pointerdown', 40, 10); });
    await act(async () => { pointer(tab, 'pointerup', 45, 12); });
    assert.deepEqual(sent, ['Tab'], 'a small wobble is still a tap');

    // A browser that starts a pan-x scroll sends pointercancel instead of pointerup.
    await act(async () => { pointer(tab, 'pointerdown', 40, 10); });
    await act(async () => { pointer(tab, 'pointercancel', 40, 10); });
    await act(async () => { pointer(tab, 'pointerup', 40, 10); });
    assert.deepEqual(sent, ['Tab'], 'nothing after pointercancel, even if a stray pointerup follows');

    // Far away and back: the press already became a scroll.
    await act(async () => { pointer(tab, 'pointerdown', 40, 10); });
    await act(async () => { pointer(tab, 'pointermove', 80, 10); });
    await act(async () => { pointer(tab, 'pointermove', 41, 10); });
    await act(async () => { pointer(tab, 'pointerup', 41, 10); });
    assert.deepEqual(sent, ['Tab'], 'a drag that returns to its start is still a drag');

    // Pressed on one key, released on another: no key.
    const esc = [...view.container.querySelectorAll('button')]
      .find(b => b.querySelector('.mobile-key__label')?.textContent === 'Esc')!;
    await act(async () => { pointer(tab, 'pointerdown', 40, 10); });
    await act(async () => { pointer(esc, 'pointerup', 42, 10); });
    assert.deepEqual(sent, ['Tab'], 'release on a different key sends nothing');

    await act(async () => { pointer(tab, 'pointerdown', 40, 10); });
    await act(async () => { pointer(tab, 'pointerup', 40, 10); });
    assert.deepEqual(sent, ['Tab', 'Tab'], 'a fresh tap after all that still sends');
    assert.equal(document.activeElement, textarea);
  } finally {
    await view.cleanup();
    host.remove();
  }
});

test('FR-MKB-006 AC-6 / SDS-AC-12: every aria label and title in the bar comes from the catalog, present in en and ko', async () => {
  const view = await render(React.createElement(MobileKeyBar, {
    onSendKey: () => {}, onToggleKeyboard: () => {}, keyboardOpen: false,
  }));
  try {
    const enValues = new Set(Object.values(en));
    for (const button of view.container.querySelectorAll('button')) {
      const aria = button.getAttribute('aria-label') ?? '';
      assert.ok(enValues.has(aria), `aria-label "${aria}" is a catalog value`);
      assert.equal(button.getAttribute('title'), aria);
    }
    for (const entry of MOBILE_BAR_KEYS) {
      if (entry.kind === 'sep') continue;
      assert.ok(entry.ariaKey in en, `${entry.ariaKey} is in en`);
      assert.ok(entry.ariaKey in ko, `${entry.ariaKey} is in ko`);
      assert.match(entry.label, /^[\x20-\x7e←-↓]+$/, 'key caps are ASCII constants (arrows as escapes)');
    }
  } finally {
    await view.cleanup();
  }

  // Hard-coded English would also pass the check above; switching the catalog
  // proves the labels are looked up at render time through t().
  installCatalog('ko', ko);
  const koView = await render(React.createElement(MobileKeyBar, {
    onSendKey: () => {}, onToggleKeyboard: () => {}, keyboardOpen: false,
  }));
  try {
    const esc = [...koView.container.querySelectorAll('button')]
      .find(b => b.querySelector('.mobile-key__label')?.textContent === 'Esc')!;
    assert.equal(esc.getAttribute('aria-label'), ko['mobileKeyboard.key.esc']);
    const toggle = [...koView.container.querySelectorAll('button')].at(-1)!;
    assert.equal(toggle.getAttribute('aria-label'), ko['mobileKeyboard.switch.toSpecial']);
  } finally {
    await koView.cleanup();
    installCatalog('en', en);
  }
});

test('FR-MKB-005 AC-1 AC-2 AC-4 AC-5: the stylesheet draws each latch state and the hold fill, and blocks selection', () => {
  const css = readFileSync(new URL('../../src/components/MobileKeyboard/mobileKeyboard.css', import.meta.url), 'utf8');
  for (const selector of ['[data-latch-state="once"]', '[data-latch-state="locked"]', '.mobile-key__dot', '.mobile-key--holding', '.mobile-key__hold']) {
    assert.ok(css.includes(selector), `mobileKeyboard.css styles ${selector}`);
  }
  assert.match(css, /user-select:\s*none/);
  assert.match(css, /-webkit-touch-callout:\s*none/);
  assert.match(css, /transition:[^;]*750ms/, 'the hold fill rises over 750 ms (LATCH_HOLD_MS)');
});

// --- useTerminalInputFocus ----------------------------------------------------

test('FR-MKB-006 AC-2 / SDS-AC-8: focus on the active tab helper textarea reports true; focusout or another tab reports false', async () => {
  const makeHost = (id: string) => {
    const host = document.createElement('div');
    host.setAttribute('data-tab-id', id);
    const ta = document.createElement('textarea');
    ta.className = 'xterm-helper-textarea';
    host.appendChild(ta);
    document.body.appendChild(host);
    return { host, ta };
  };
  const a = makeHost('tab-a');
  const b = makeHost('tab-b');
  const other = document.createElement('input');
  document.body.appendChild(other);

  const seen: boolean[] = [];
  function Probe(props: { activeTabId: string | null }): null {
    seen.push(useTerminalInputFocus(props.activeTabId, true));
    return null;
  }
  const view = await render(React.createElement(Probe, { activeTabId: 'tab-a' }));
  try {
    assert.equal(seen.at(-1), false);
    await act(async () => { a.ta.focus(); });
    assert.equal(seen.at(-1), true, 'active tab helper textarea focused');
    await act(async () => { other.focus(); });
    assert.equal(seen.at(-1), false, 'focus left the terminal');
    await act(async () => { b.ta.focus(); });
    assert.equal(seen.at(-1), false, 'another tab is not the active tab');
    await act(async () => { view.root.render(React.createElement(Probe, { activeTabId: 'tab-b' })); });
    assert.equal(seen.at(-1), true, 'switching the active tab re-reads the focused element');
    await act(async () => { b.ta.blur(); });
    assert.equal(seen.at(-1), false, 'focusout to nothing');

    // A browser that lets a tap move focus onto the bar must not hide the bar.
    const bar = document.createElement('div');
    bar.className = 'mobile-key-bar';
    const barButton = document.createElement('button');
    bar.appendChild(barButton);
    document.body.appendChild(bar);
    try {
      await act(async () => { b.ta.focus(); });
      assert.equal(seen.at(-1), true);
      await act(async () => { barButton.focus(); });
      assert.equal(seen.at(-1), true, 'focus on the key bar keeps the bar shown');
      await act(async () => { b.ta.focus(); });
      assert.equal(seen.at(-1), true);
    } finally {
      bar.remove();
    }
  } finally {
    await view.cleanup();
    a.host.remove();
    b.host.remove();
    other.remove();
  }
});

// --- Focus hand-back for latch keys and the switch (review FND-003) ----------

test('FR-MKB-006 AC-4 / SDS-AC-6: when a browser moved focus onto Ctrl, Alt or the switch, pointerup hands it back to the terminal', async () => {
  const textarea = document.createElement('textarea');
  textarea.className = 'xterm-helper-textarea';
  document.body.appendChild(textarea);
  let restores = 0;
  const view = await render(React.createElement(MobileKeyBar, {
    onSendKey: () => {}, onToggleKeyboard: () => {}, keyboardOpen: false,
    onRestoreFocus: () => { restores += 1; textarea.focus(); },
  }));
  try {
    const targets = [
      view.container.querySelector('[data-mod="ctrl"]') as HTMLButtonElement,
      view.container.querySelector('[data-mod="alt"]') as HTMLButtonElement,
      view.container.querySelector('[data-mobile-action="toggle-keyboard"]') as HTMLButtonElement,
    ];
    for (const button of targets) {
      // Simulates a browser that ignores the pointerdown preventDefault.
      await act(async () => { button.focus(); });
      assert.equal(document.activeElement, button);
      const before = restores;
      await act(async () => { pointer(button, 'pointerdown', 5, 5); });
      await act(async () => { pointer(button, 'pointerup', 5, 5); });
      assert.equal(restores, before + 1, `${button.getAttribute('aria-label')} hands focus back`);
      assert.equal(document.activeElement, textarea);
    }
    // Focus already on the terminal: nothing to hand back.
    const before = restores;
    const ctrl = targets[0];
    await act(async () => { pointer(ctrl, 'pointerdown', 5, 5); });
    await act(async () => { pointer(ctrl, 'pointerup', 5, 5); });
    assert.equal(restores, before, 'no hand-back while the terminal keeps focus');
  } finally {
    await view.cleanup();
    textarea.remove();
  }
});

// --- App-level decisions (review FND-001) ------------------------------------

test('FR-MKB-006 AC-2 / SDS-AC-8: the bar shows only on a phone, on the workspace screen, with an active tab whose input has focus', () => {
  const base = { isMobile: true, screen: 'workspace', hasActiveTab: true, inputFocused: true };
  assert.equal(shouldShowMobileKeyBar(base), true);
  assert.equal(shouldShowMobileKeyBar({ ...base, isMobile: false }), false, 'never on desktop');
  assert.equal(shouldShowMobileKeyBar({ ...base, screen: 'settings' }), false);
  assert.equal(shouldShowMobileKeyBar({ ...base, hasActiveTab: false }), false);
  assert.equal(shouldShowMobileKeyBar({ ...base, inputFocused: false }), false);
});

test('FR-MKB-006 AC-7: leaving mobile mode resets every latch; staying mobile keeps it', async () => {
  function Probe({ isMobile }: { isMobile: boolean }): null {
    useResetLatchWhenNotMobile(isMobile);
    return null;
  }
  const view = await render(React.createElement(Probe, { isMobile: true }));
  try {
    await act(async () => { mobileModifierLatch.tap('ctrl'); mobileModifierLatch.tap('alt'); });
    await act(async () => { view.root.render(React.createElement(Probe, { isMobile: true })); });
    assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'once', 'a re-render in mobile mode keeps the latch');
    await act(async () => { view.root.render(React.createElement(Probe, { isMobile: false })); });
    const snap = mobileModifierLatch.getSnapshot();
    assert.equal(snap.ctrl, 'off');
    assert.equal(snap.alt, 'off');
  } finally {
    await view.cleanup();
  }
});

// FR-MKB-006 AC-5: jsdom does no layout, so the overflow behaviour is pinned on
// the stylesheet rules the rendered bar actually uses. A bare "selector is
// present" check is satisfied by a rule that does nothing, so each check reads
// the declaration value inside the exact rule and resolves the height token.
const CSS_RULE = /([^{}]+)\{([^{}]*)\}/g;

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function cssRule(css: string, selector: string): Map<string, string> {
  const rules = [...stripCssComments(css).matchAll(CSS_RULE)]
    .filter(match => match[1].split(',').map(part => part.trim()).includes(selector));
  assert.equal(rules.length, 1, `exactly one rule for ${selector}`);
  const declarations = new Map<string, string>();
  for (const line of rules[0][2].split(';')) {
    const colon = line.indexOf(':');
    if (colon > 0) declarations.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return declarations;
}

function resolvePx(value: string | undefined, tokens: string): number {
  assert.ok(value, 'a height is declared');
  const token = /^var\((--[\w-]+)\)$/.exec(value);
  const literal = token ? new RegExp(`${token[1]}:\\s*([^;]+);`).exec(tokens)?.[1]?.trim() : value;
  const px = /^(\d+(?:\.\d+)?)px$/.exec(literal ?? '');
  assert.ok(px, `height ${value} resolves to a px length (got ${literal})`);
  return Number(px[1]);
}

test('FR-MKB-006 AC-5: the bar scrolls sideways without a visible scrollbar, and every button is at least 36 px tall', async () => {
  const css = readFileSync(new URL('../../src/components/MobileKeyboard/mobileKeyboard.css', import.meta.url), 'utf8');
  const tokens = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8');

  // Rendered structure: the classes the rules below are written against.
  const view = await render(React.createElement(MobileKeyBar, {
    onSendKey: () => {}, onToggleKeyboard: () => {}, keyboardOpen: false,
  }));
  try {
    const bar = view.container.firstElementChild!;
    assert.ok(bar.classList.contains('mobile-key-bar'), 'the bar root carries .mobile-key-bar');
    const buttons = [...bar.querySelectorAll('button')];
    assert.equal(buttons.length, MOBILE_BAR_KEYS.filter(entry => entry.kind !== 'sep').length + 1, 'every key plus the switch');
    for (const button of buttons) {
      assert.ok(button.classList.contains('mobile-key'), `${button.textContent} carries .mobile-key`);
    }
    for (const sep of bar.querySelectorAll('[data-mobile-sep]')) {
      assert.ok(sep.classList.contains('mobile-key-bar__sep'), 'separators carry .mobile-key-bar__sep');
    }
  } finally {
    await view.cleanup();
  }

  // Horizontal scroll: one flex row that overflows sideways instead of wrapping,
  // with items that keep their width instead of shrinking to fit the screen.
  const barRule = cssRule(css, '.mobile-key-bar');
  assert.equal(barRule.get('display'), 'flex');
  assert.match(barRule.get('overflow-x') ?? '', /^(auto|scroll)$/, 'the bar scrolls horizontally');
  assert.equal(barRule.get('overflow-y'), 'hidden', 'and never vertically');
  assert.ok(!/\bwrap\b/.test(`${barRule.get('flex-wrap') ?? ''} ${barRule.get('flex-flow') ?? ''}`), 'items do not wrap');
  assert.equal(cssRule(css, '.mobile-key').get('flex'), 'none', 'keys do not shrink to fit the screen');
  assert.equal(cssRule(css, '.mobile-key-bar__sep').get('flex'), 'none', 'separators do not shrink');

  // Hidden scrollbar: the standard property and the WebKit pseudo-element.
  assert.equal(barRule.get('scrollbar-width'), 'none', 'standard scrollbar hidden');
  assert.equal(cssRule(css, '.mobile-key-bar::-webkit-scrollbar').get('display'), 'none', 'WebKit scrollbar hidden');

  // Button height >= 36 px, and the bar is tall enough not to clip it.
  const keyHeight = resolvePx(cssRule(css, '.mobile-key').get('height'), tokens);
  assert.ok(keyHeight >= 36, `.mobile-key height ${keyHeight}px >= 36px`);
  const barHeight = resolvePx(barRule.get('height'), tokens);
  assert.ok(barHeight >= keyHeight, `bar height ${barHeight}px fits the ${keyHeight}px buttons`);
  // No modifier rule on a button may bring it below 36 px.
  for (const match of stripCssComments(css).matchAll(CSS_RULE)) {
    const selector = match[1].trim();
    if (!/\.mobile-key(--[\w-]+)?(\[|:|\s*$)/.test(selector)) continue;
    for (const prop of ['height', 'max-height']) {
      const value = new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`).exec(match[2])?.[1]?.trim();
      if (value === undefined) continue;
      assert.ok(resolvePx(value, tokens) >= 36, `${selector} ${prop} ${value} keeps the button at least 36 px`);
    }
  }
});

// --- Wave 3: drag cancel on latch keys, and no focus watch on desktop ---------

test('FR-MKB-011 AC-3 / SDS-AC-10: a Ctrl press dragged 20 px before release is cancelled and leaves the modifier off', async () => {
  const view = await render(React.createElement(MobileKeyBar, {
    onSendKey: () => {}, onToggleKeyboard: () => {}, keyboardOpen: false,
  }));
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const ctrl = view.container.querySelector('[data-mod="ctrl"]')!;
    await act(async () => { pointer(ctrl, 'pointerdown', 40, 10); });
    await act(async () => { pointer(ctrl, 'pointermove', 60, 10); });
    assert.equal(ctrl.classList.contains('mobile-key--holding'), false, 'the hold fill stops once the press became a drag');
    await act(async () => { pointer(ctrl, 'pointerup', 60, 10); });
    await act(async () => { mock.timers.tick(LATCH_HOLD_MS * 2); });
    assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'off', 'a drag neither taps nor locks');

    // Dragged and then held past the lock time: the drag already ended the press.
    await act(async () => { pointer(ctrl, 'pointerdown', 40, 10); });
    await act(async () => { pointer(ctrl, 'pointermove', 60, 10); });
    await act(async () => { mock.timers.tick(LATCH_HOLD_MS * 2); });
    assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'off', 'a dragged press never locks');
    await act(async () => { pointer(ctrl, 'pointerup', 60, 10); });
    assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'off');

    // Released 20 px away without a move event in between: still a drag.
    await act(async () => { pointer(ctrl, 'pointerdown', 40, 10); });
    await act(async () => { pointer(ctrl, 'pointerup', 40, 30); });
    assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'off');

    // A small wobble is still a tap.
    await act(async () => { pointer(ctrl, 'pointerdown', 40, 10); });
    await act(async () => { pointer(ctrl, 'pointermove', 44, 12); });
    await act(async () => { pointer(ctrl, 'pointerup', 44, 12); });
    assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'once');
  } finally {
    mock.timers.reset();
    await view.cleanup();
  }
});

test('FR-MKB-011 AC-3 / SDS-AC-10: another pointer moving or lifting far away does not cancel or release a Ctrl press', async () => {
  const view = await render(React.createElement(MobileKeyBar, {
    onSendKey: () => {}, onToggleKeyboard: () => {}, keyboardOpen: false,
  }));
  const second = (target: Element, type: string, x: number, y: number): void => {
    target.dispatchEvent(new (win().PointerEvent)(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 2, isPrimary: false,
    }));
  };
  try {
    const ctrl = view.container.querySelector('[data-mod="ctrl"]')!;
    await act(async () => { pointer(ctrl, 'pointerdown', 40, 10); });
    await act(async () => { second(ctrl, 'pointermove', 200, 10); });
    assert.equal(ctrl.classList.contains('mobile-key--holding'), true, 'a second finger moving does not turn the press into a drag');
    await act(async () => { second(ctrl, 'pointerup', 200, 10); });
    assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'off', 'the second finger lifting neither taps nor ends the press');
    assert.equal(ctrl.classList.contains('mobile-key--holding'), true);
    await act(async () => { pointer(ctrl, 'pointerup', 40, 10); });
    assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'once', 'the pressing finger lifting is the tap');
  } finally {
    await view.cleanup();
  }
});

test('FR-MKB-011 AC-4 / SDS-AC-11: with enabled false the focus watch attaches no focusin listener and reports false', async () => {
  const added: string[] = [];
  const original = document.addEventListener.bind(document);
  document.addEventListener = ((type: string, ...rest: unknown[]) => {
    added.push(type);
    return (original as (...args: unknown[]) => void)(type, ...rest);
  }) as typeof document.addEventListener;
  const seen: boolean[] = [];
  function Probe(props: { enabled: boolean }): null {
    seen.push(useTerminalInputFocus('tab-a', props.enabled));
    return null;
  }
  const host = document.createElement('div');
  host.setAttribute('data-tab-id', 'tab-a');
  const ta = document.createElement('textarea');
  ta.className = 'xterm-helper-textarea';
  host.appendChild(ta);
  document.body.appendChild(host);
  ta.focus();
  let view: Awaited<ReturnType<typeof render>> | null = null;
  try {
    view = await render(React.createElement(Probe, { enabled: false }));
    assert.deepEqual(added.filter(type => type === 'focusin' || type === 'focusout'), [], 'no listener on desktop');
    assert.equal(seen.at(-1), false, 'desktop never reports terminal input focus');
    await act(async () => { view!.root.render(React.createElement(Probe, { enabled: true })); });
    assert.ok(added.includes('focusin'), 'mobile attaches the watch');
    assert.equal(seen.at(-1), true);
  } finally {
    document.addEventListener = original;
    await view?.cleanup();
    host.remove();
  }
});
