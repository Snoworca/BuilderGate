// FR-MSG-013 AC-6: on a phone the messenger window fills the screen. With the
// keyboard up iOS keeps the layout as tall as the screen and pans the visible part,
// so a window as tall as innerHeight ran under the keyboard and its conversation
// could not be scrolled. The window follows the visible part instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keyboardViewportRect } from '../../src/components/Messenger/messengerViewport.ts';

const SCREEN = { width: 402, height: 812 };

test('FR-MSG-013 AC-6: without the keyboard the window fills the screen it is given', () => {
  assert.deepEqual(keyboardViewportRect(SCREEN, { offsetTop: 0, height: 812, scale: 1 }, 0, false), { x: 0, y: 0, width: 402, height: 812 });
  assert.deepEqual(keyboardViewportRect(SCREEN, null, 0, true), { x: 0, y: 0, width: 402, height: 812 });
});

test('FR-MSG-013 AC-6: with the keyboard up the window spans the visible part, panned or not', () => {
  // A browser tab: iOS panned the page 300 px to show the composer above the keyboard.
  assert.deepEqual(keyboardViewportRect(SCREEN, { offsetTop: 300, height: 450, scale: 1 }, 0, true), { x: 0, y: 300, width: 402, height: 450 });
  // Not panned: the window ends at the keyboard.
  assert.deepEqual(keyboardViewportRect(SCREEN, { offsetTop: 0, height: 450, scale: 1 }, 0, true), { x: 0, y: 0, width: 402, height: 450 });
});

test('FR-MSG-013 AC-6: in the home-screen app the window still starts below the status bar', () => {
  // The window layer starts 62 px down (the status bar); rects are relative to it.
  const app = { width: 402, height: 778 };
  assert.deepEqual(keyboardViewportRect(app, { offsetTop: 0, height: 500, scale: 1 }, 62, true), { x: 0, y: 0, width: 402, height: 438 });
  assert.deepEqual(keyboardViewportRect(app, { offsetTop: 200, height: 500, scale: 1 }, 62, true), { x: 0, y: 138, width: 402, height: 500 });
});

test('FR-MSG-013 AC-6: a pinch zoom leaves the window as it is', () => {
  assert.deepEqual(keyboardViewportRect(SCREEN, { offsetTop: 300, height: 200, scale: 2 }, 0, true), { x: 0, y: 0, width: 402, height: 812 });
});

test('FR-MSG-013 AC-6: the phone window rect follows the visual viewport', () => {
  const source = readFileSync(new URL('../../src/components/Messenger/messengerFormat.ts', import.meta.url), 'utf8');
  assert.match(source, /keyboardViewportRect\(/, 'useViewportRect places the window by the visible part');
  assert.match(source, /visualViewport\??\.addEventListener\('resize'/, 'it re-reads when the keyboard opens or closes');
  assert.match(source, /visualViewport\??\.addEventListener\('scroll'/, 'and when iOS pans the page');
});
