// FR-ARCH-016 AC-6: opened from the iPhone home screen, BuilderGate covers the whole
// screen and keeps its content out of the status bar and the home indicator itself,
// so the bottom row (the git status row) shows from launch on iOS 26.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  STANDALONE_CLASS,
  installStandaloneViewport,
  isStandaloneDisplay,
  type StandaloneDocumentLike,
  type StandaloneWindowLike,
} from '../../src/utils/standaloneViewport.ts';

const TAB_VIEWPORT = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no';

function fakeWindow(opts: { iosStandalone?: boolean; displayModeStandalone?: boolean }): StandaloneWindowLike {
  return {
    navigator: opts.iosStandalone === undefined ? {} : { standalone: opts.iosStandalone },
    matchMedia: (query: string) => ({
      matches: query === '(display-mode: standalone)' && opts.displayModeStandalone === true,
    }),
  };
}

function fakeDocument(viewport: string | null): StandaloneDocumentLike & { content(): string | null; classes: Set<string> } {
  let content = viewport;
  const classes = new Set<string>();
  const meta = viewport === null ? null : {
    getAttribute: (name: string) => (name === 'content' ? content : null),
    setAttribute: (name: string, value: string) => { if (name === 'content') content = value; },
  };
  return {
    querySelector: (selector: string) => (selector === 'meta[name="viewport"]' ? meta : null),
    documentElement: { classList: { add: (name: string) => { classes.add(name); } } },
    content: () => content,
    classes,
  };
}

test('FR-ARCH-016 AC-6: a home-screen app is detected by navigator.standalone or the display mode', () => {
  assert.equal(isStandaloneDisplay(fakeWindow({ iosStandalone: true })), true);
  assert.equal(isStandaloneDisplay(fakeWindow({ displayModeStandalone: true })), true);
  assert.equal(isStandaloneDisplay(fakeWindow({ iosStandalone: false })), false);
  assert.equal(isStandaloneDisplay(fakeWindow({})), false);
});

test('FR-ARCH-016 AC-6: in the home-screen app the viewport covers the screen and the root is marked', () => {
  const doc = fakeDocument(TAB_VIEWPORT);
  assert.equal(installStandaloneViewport(fakeWindow({ iosStandalone: true }), doc), true);
  assert.equal(doc.content(), `${TAB_VIEWPORT}, viewport-fit=cover`);
  assert.deepEqual([...doc.classes], [STANDALONE_CLASS]);
});

test('FR-ARCH-016 AC-6: installing twice adds viewport-fit once', () => {
  const doc = fakeDocument(TAB_VIEWPORT);
  const win = fakeWindow({ iosStandalone: true });
  installStandaloneViewport(win, doc);
  installStandaloneViewport(win, doc);
  assert.equal(doc.content(), `${TAB_VIEWPORT}, viewport-fit=cover`);
});

test('FR-ARCH-016 AC-4: in a browser tab the viewport and the root stay as they were', () => {
  const doc = fakeDocument(TAB_VIEWPORT);
  assert.equal(installStandaloneViewport(fakeWindow({ iosStandalone: false }), doc), false);
  assert.equal(doc.content(), TAB_VIEWPORT);
  assert.equal(doc.classes.size, 0);
});

test('FR-ARCH-016 AC-6: the status bar is translucent, so the app owns the area under it', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const tag = html.match(/<meta[^>]*name="apple-mobile-web-app-status-bar-style"[^>]*>/)?.[0] ?? '';
  assert.match(tag, /content="black-translucent"/);
});

test('FR-ARCH-016 AC-6: the standalone root keeps content inside the safe area, and main.tsx installs it before render', () => {
  const css = readFileSync(new URL('../../src/styles/globals.css', import.meta.url), 'utf8');
  const rule = css.match(new RegExp(`html\\.${STANDALONE_CLASS}\\s*\\{[^}]*\\}`))?.[0] ?? '';
  for (const side of ['top', 'right', 'bottom', 'left']) {
    assert.match(rule, new RegExp(`env\\(safe-area-inset-${side}`), `html.${STANDALONE_CLASS} pads the ${side} inset`);
  }
  const locked = css.match(new RegExp(`html\\.${STANDALONE_CLASS} \\.app\\.app--viewport-locked\\s*\\{[^}]*\\}`))?.[0] ?? '';
  assert.match(locked, /padding-top:\s*env\(safe-area-inset-top/, 'the keyboard-locked app also clears the status bar');

  const main = readFileSync(new URL('../../src/main.tsx', import.meta.url), 'utf8');
  const install = main.indexOf('installStandaloneViewport(window, document)');
  assert.ok(install >= 0, 'main.tsx installs the standalone viewport');
  assert.ok(install < main.indexOf('createRoot('), 'before the first render');
});
