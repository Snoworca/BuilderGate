// FR-MKB-013 (#147): the mobile key bar shows only while the system keyboard is
// up (or the special keyboard panel is open). Android's back button closes the
// keyboard but leaves the terminal focused, which used to leave the bar alone at
// the bottom of the screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installJsdomEnvironment } from './jsdomEnvironment.ts';
import {
  decideMobileKeyBar,
  MOBILE_KEY_BAR_HIDE_GRACE_MS,
  useMobileKeyBarVisible,
} from '../../src/components/MobileKeyboard/mobileKeyboardModel.ts';
import {
  isSystemKeyboardUp,
  KEYBOARD_UP_MIN_INSET,
  useSystemKeyboardUp,
} from '../../src/hooks/useVisualViewportInset.ts';

function fakeWindow(innerHeight: number, vv?: { height: number; offsetTop: number }): Window {
  return { innerHeight, visualViewport: vv } as unknown as Window;
}

test('FR-MKB-013 AC-1: the keyboard is up from an inset of 120 px; without visualViewport it counts as up', () => {
  assert.equal(KEYBOARD_UP_MIN_INSET, 120);
  assert.equal(isSystemKeyboardUp(fakeWindow(900, { height: 900, offsetTop: 0 })), false);
  assert.equal(isSystemKeyboardUp(fakeWindow(900, { height: 790, offsetTop: 0 })), false, 'a collapsing toolbar is not a keyboard');
  assert.equal(isSystemKeyboardUp(fakeWindow(900, { height: 780, offsetTop: 0 })), true);
  assert.equal(isSystemKeyboardUp(fakeWindow(900, { height: 500, offsetTop: 0 })), true);
  assert.equal(isSystemKeyboardUp(fakeWindow(900)), true);
});

test('FR-MKB-013 AC-2 AC-3: focus with the keyboard up shows, focus with it down waits, the panel shows, the rest hides', () => {
  const base = { isMobile: true, screen: 'workspace', hasActiveTab: true, inputFocused: true, keyboardUp: true, panelOpen: false };
  assert.equal(decideMobileKeyBar(base), 'show');
  assert.equal(decideMobileKeyBar({ ...base, keyboardUp: false }), 'pending');
  assert.equal(decideMobileKeyBar({ ...base, keyboardUp: false, inputFocused: false, panelOpen: true }), 'show', 'the panel keeps the bar');
  assert.equal(decideMobileKeyBar({ ...base, inputFocused: false }), 'hide');
  assert.equal(decideMobileKeyBar({ ...base, isMobile: false }), 'hide');
  assert.equal(decideMobileKeyBar({ ...base, screen: 'settings' }), 'hide');
  assert.equal(decideMobileKeyBar({ ...base, hasActiveTab: false }), 'hide');
});

test('FR-MKB-013 AC-3: a pending bar keeps its state for the grace period, then hides', async () => {
  installJsdomEnvironment();
  const React = await import('react');
  const { act } = React;
  const { createRoot } = await import('react-dom/client');
  const seen: boolean[] = [];
  function Probe({ decision }: { decision: 'show' | 'hide' | 'pending' }): null {
    seen.push(useMobileKeyBarVisible(decision));
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (decision: 'show' | 'hide' | 'pending') => act(async () => { root.render(React.createElement(Probe, { decision })); });
  const wait = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
  try {
    // Focus lands while the keyboard is still rising: stays hidden.
    await render('pending');
    assert.equal(seen.at(-1), false);
    await render('show');
    assert.equal(seen.at(-1), true);

    // The keyboard goes down (back button): the bar stays for the grace period, then hides.
    await render('pending');
    assert.equal(seen.at(-1), true);
    await wait(MOBILE_KEY_BAR_HIDE_GRACE_MS + 100);
    assert.equal(seen.at(-1), false);

    // Panel -> system keyboard: the keyboard comes back inside the grace period.
    await render('show');
    await render('pending');
    await wait(MOBILE_KEY_BAR_HIDE_GRACE_MS / 2);
    await render('show');
    await wait(MOBILE_KEY_BAR_HIDE_GRACE_MS);
    assert.equal(seen.at(-1), true, 'no hide once the keyboard is back');

    // Losing focus hides at once.
    await render('hide');
    assert.equal(seen.at(-1), false);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test('FR-MKB-013 AC-4: the keyboard hook re-renders only when the threshold is crossed, and subscribes to nothing when disabled', async () => {
  installJsdomEnvironment();
  const React = await import('react');
  const { act } = React;
  const { createRoot } = await import('react-dom/client');
  class FakeVisualViewport extends EventTarget {
    height = 900;
    offsetTop = 0;
    listeners = 0;
    addEventListener(...args: Parameters<EventTarget['addEventListener']>): void { this.listeners += 1; super.addEventListener(...args); }
    removeEventListener(...args: Parameters<EventTarget['removeEventListener']>): void { this.listeners -= 1; super.removeEventListener(...args); }
  }
  const vv = new FakeVisualViewport();
  Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
  let renders = 0;
  const seen: boolean[] = [];
  function Probe({ enabled }: { enabled: boolean }): null {
    renders += 1;
    seen.push(useSystemKeyboardUp(enabled));
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(React.createElement(Probe, { enabled: false })); });
    assert.equal(vv.listeners, 0, 'desktop subscribes to nothing');

    await act(async () => { root.render(React.createElement(Probe, { enabled: true })); });
    assert.equal(seen.at(-1), false);
    const before = renders;
    vv.height = 880;
    await act(async () => { vv.dispatchEvent(new Event('resize')); });
    assert.equal(renders, before, 'a change below the threshold does not re-render');
    vv.height = 520;
    await act(async () => { vv.dispatchEvent(new Event('resize')); });
    assert.equal(seen.at(-1), true);
    vv.height = 500;
    const up = renders;
    await act(async () => { vv.dispatchEvent(new Event('scroll')); });
    assert.equal(renders, up, 'staying up does not re-render');
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
  assert.equal(vv.listeners, 0, 'unsubscribed on unmount');
});

test('FR-MKB-013 AC-2: App gates the bar on the keyboard and the grace hook', () => {
  const source = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  assert.match(source, /useSystemKeyboardUp\(isMobile\)/u);
  assert.match(source, /decideMobileKeyBar\(\{/u);
  assert.match(source, /const showMobileKeyBar = useMobileKeyBarVisible\(/u);
});
