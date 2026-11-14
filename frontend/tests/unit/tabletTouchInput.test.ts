// FR-ARCH-008 AC-4, FR-MKB-013 AC-5: an iPad keeps the desktop layout (FR-UIDS-015) but its
// primary pointer is a finger. The terminal's one-finger scroll and pinch, its touch-action and
// the mobile key bar were all gated on the layout, so on an iPad a drag over a terminal bounced
// the whole page instead of scrolling it and the key bar never appeared (user report 2026-11-14).
// Touch behaviour now follows the input device; the layout still follows MOBILE_LAYOUT_QUERY.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { installJsdomEnvironment } from './jsdomEnvironment.ts';
import { MOBILE_LAYOUT_QUERY } from '../../src/utils/layoutMode.ts';

const read = (rel: string) => readFileSync(new URL(`../../src/${rel}`, import.meta.url), 'utf8');
const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// @req FR-ARCH-008
// @req FR-MKB-013
test('FR-ARCH-008 AC-4 / FR-MKB-013 AC-5: touch input is the mobile layout or a coarse primary pointer', async () => {
  const { TOUCH_INPUT_QUERY, usesTouchInput } = await import('../../src/utils/touchInput.ts');
  assert.equal(TOUCH_INPUT_QUERY, '(pointer: coarse)');
  assert.equal(usesTouchInput({ mobileLayout: false, coarsePointer: true }), true, 'a tablet in the desktop layout');
  assert.equal(usesTouchInput({ mobileLayout: true, coarsePointer: true }), true, 'a phone');
  assert.equal(usesTouchInput({ mobileLayout: true, coarsePointer: false }), true, 'a narrow desktop window keeps the phone behaviour');
  assert.equal(usesTouchInput({ mobileLayout: false, coarsePointer: false }), false, 'a desktop');
});

// @req FR-MKB-013
test('FR-MKB-013 AC-5: useResponsive reports touch input for an iPad that keeps the desktop layout, and follows a change', async () => {
  installJsdomEnvironment();
  const React = await import('react');
  const { act } = React;
  const { createRoot } = await import('react-dom/client');
  const { useResponsive } = await import('../../src/hooks/useResponsive.ts');

  const matches = new Map<string, boolean>([[MOBILE_LAYOUT_QUERY, false], ['(pointer: coarse)', true]]);
  const listeners = new Map<string, Set<(event: { matches: boolean }) => void>>();
  const originalMatchMedia = window.matchMedia;
  const fakeMatchMedia = (query: string) => ({
    get matches() { return matches.get(query) ?? false; },
    media: query,
    addEventListener(_type: string, listener: (event: { matches: boolean }) => void) {
      if (!listeners.has(query)) listeners.set(query, new Set());
      listeners.get(query)!.add(listener);
    },
    removeEventListener(_type: string, listener: (event: { matches: boolean }) => void) {
      listeners.get(query)?.delete(listener);
    },
  });
  (window as unknown as Record<string, unknown>).matchMedia = fakeMatchMedia;

  const seen: Array<{ isMobile: boolean; isTouchInput: boolean }> = [];
  function Probe(): null {
    const { isMobile, isTouchInput } = useResponsive();
    seen.push({ isMobile, isTouchInput });
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(React.createElement(Probe)); });
    assert.deepEqual(seen.at(-1), { isMobile: false, isTouchInput: true }, 'desktop layout, touch input');

    // A trackpad or mouse becomes the primary pointer.
    matches.set('(pointer: coarse)', false);
    await act(async () => { for (const l of listeners.get('(pointer: coarse)') ?? []) l({ matches: false }); });
    assert.deepEqual(seen.at(-1), { isMobile: false, isTouchInput: false });
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    (window as unknown as Record<string, unknown>).matchMedia = originalMatchMedia;
  }
  assert.equal(listeners.get('(pointer: coarse)')?.size ?? 0, 0, 'unsubscribed on unmount');
});

// @req FR-ARCH-008
test('FR-ARCH-008 AC-4: the terminal attaches its touch scroll and pinch, and touch-action none, on touch input rather than the phone layout', () => {
  const view = stripComments(read('components/Terminal/TerminalView.tsx'));
  assert.match(view, /const \{[^}]*\bisTouchInput\b[^}]*\} = useResponsive\(\)/);
  const attach = view.indexOf("addEventListener('touchstart', handleMobileTouchStart");
  assert.ok(attach > 0, 'the touch listeners are attached');
  const effectStart = view.lastIndexOf('useEffect(', attach);
  const effect = view.slice(effectStart, view.indexOf('}, [', attach));
  assert.match(effect, /if \(!isTouchInput\) return;/, 'gated on touch input');
  assert.doesNotMatch(effect, /isMobile/, 'not on the phone layout');
  assert.match(view, /style=\{isTouchInput \? \{ touchAction: 'none' \} : undefined\}/);
});

// @req FR-ARCH-008
test('FR-ARCH-008 AC-4: the document never overscrolls, so an unhandled drag cannot bounce the whole app', () => {
  const css = stripComments(read('styles/globals.css'));
  const rootRule = /html, body, #root \{([^}]*)\}/.exec(css);
  assert.ok(rootRule, 'the root rule exists');
  assert.match(rootRule[1], /overscroll-behavior: none;/);
});

// @req FR-MKB-013
test('FR-MKB-013 AC-5: App gates the key bar, focus watch and keyboard detection on touch input', () => {
  const app = stripComments(read('App.tsx'));
  assert.match(app, /const \{[^}]*\bisTouchInput\b[^}]*\} = useResponsive\(\)/);
  assert.match(app, /useTerminalInputFocus\(\s*activeTab\?\.id\s*\?\?\s*null\s*,\s*isTouchInput\s*\)/);
  assert.match(app, /useSystemKeyboardUp\(isTouchInput\)/);
  assert.match(app, /decideMobileKeyBar\(\{\s*isMobile:\s*isTouchInput,/);
  assert.match(app, /if\s*\(\s*!isTouchInput\s*\)\s*closeSpecialKeyboard\(\)/);
  assert.match(app, /useResetLatchWhenNotMobile\(\s*isTouchInput\s*\)/);
});
