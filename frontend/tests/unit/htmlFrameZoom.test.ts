import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  HTML_FRAME_VIEW_RESET,
  HTML_SCROLL_MESSAGE,
  HTML_TAP_MESSAGE,
  HTML_VIEWER_HELPER_SCRIPT,
  dragHtmlFrame,
  framePointOf,
  withViewerHelper,
  HTML_ZOOM_MAX_SCALE,
  htmlFrameTransform,
  maxHtmlFrameZoom,
  panHtmlFrame,
  pinchHtmlFrame,
  toggleHtmlFrameZoom,
} from '../../src/components/editor/htmlTabModel.ts';

// FR-MDE-028 AC-11: pinching the fitted page on a phone zoomed the whole app, not the page (user
// report 2026-10-28). The page runs in an opaque-origin frame, so its touches never reach the app;
// on a touch screen the fitted page is covered by a gesture surface that zooms and pans the frame
// itself, and the app's own pinch zoom is held back there.

const area = { width: 320, height: 500 };
const base = 320 / 1280;

function near(actual: number, expected: number, label: string) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`);
}

test('FR-MDE-028 AC-11: the fitted page zooms up to twice its real size and never below the fit', () => {
  assert.equal(HTML_ZOOM_MAX_SCALE, 2);
  near(maxHtmlFrameZoom(base), 8, 'max zoom at a quarter scale');
  assert.equal(maxHtmlFrameZoom(3), 1);
  const out = pinchHtmlFrame(HTML_FRAME_VIEW_RESET, area, base, {
    from: { distance: 100, mid: { x: 160, y: 250 } },
    to: { distance: 50, mid: { x: 160, y: 250 } },
  });
  assert.deepEqual(out, HTML_FRAME_VIEW_RESET);
  const big = pinchHtmlFrame(HTML_FRAME_VIEW_RESET, area, base, {
    from: { distance: 10, mid: { x: 0, y: 0 } },
    to: { distance: 1000, mid: { x: 0, y: 0 } },
  });
  near(big.zoom, 8, 'zoom capped');
});

test('FR-MDE-028 AC-11: pinching keeps the point under the fingers under the fingers', () => {
  const out = pinchHtmlFrame(HTML_FRAME_VIEW_RESET, area, base, {
    from: { distance: 100, mid: { x: 100, y: 200 } },
    to: { distance: 200, mid: { x: 100, y: 200 } },
  });
  near(out.zoom, 2, 'zoom');
  // The page point at (100, 200) before the pinch is at (100, 200) after it.
  near(out.x + 100 * out.zoom, 100, 'x');
  near(out.y + 200 * out.zoom, 200, 'y');
});

test('FR-MDE-028 AC-11: moving the fingers pans the zoomed page, never past its edges', () => {
  const zoomed = { zoom: 2, x: -100, y: -100 };
  assert.deepEqual(panHtmlFrame(zoomed, area, base, 30, -40), { zoom: 2, x: -70, y: -140 });
  // A zoom of 2 makes the page 640 x 1000 in a 320 x 500 view: x stays in [-320, 0], y in [-500, 0].
  assert.deepEqual(panHtmlFrame(zoomed, area, base, 500, -900), { zoom: 2, x: 0, y: -500 });
  // An unzoomed page does not move.
  assert.deepEqual(panHtmlFrame(HTML_FRAME_VIEW_RESET, area, base, 50, 50), HTML_FRAME_VIEW_RESET);
});

test('FR-MDE-028 AC-11: a double tap zooms to the real size at the tap, and back to the fit', () => {
  const zoomed = toggleHtmlFrameZoom(HTML_FRAME_VIEW_RESET, area, base, { x: 80, y: 100 });
  near(zoomed.zoom, 4, 'real size');
  near(zoomed.x + 80 * zoomed.zoom, 80, 'x');
  near(zoomed.y + 100 * zoomed.zoom, 100, 'y');
  assert.deepEqual(toggleHtmlFrameZoom(zoomed, area, base, { x: 10, y: 10 }), HTML_FRAME_VIEW_RESET);
});

test('FR-MDE-028 AC-11: the frame is moved, then scaled by the fit times the zoom', () => {
  assert.equal(htmlFrameTransform({ zoom: 2, x: -10, y: -20 }, 0.25), 'translate(-10px, -20px) scale(0.5)');
});

test('FR-MDE-028 AC-11: the HTML tab covers the fitted frame with a gesture surface that holds back the app zoom', () => {
  const source = readFileSync(new URL('../../src/components/editor/HtmlFileTab.tsx', import.meta.url), 'utf8');
  assert.match(source, /className="html-tab-gesture"/);
  assert.match(source, /pinchHtmlFrame\(/);
  assert.match(source, /panHtmlFrame\(/);
  assert.match(source, /toggleHtmlFrameZoom\(/);
  assert.match(source, /htmlFrameTransform\(/);
  // React's touch listeners are passive and cannot stop the browser's own zoom.
  assert.match(source, /\{ passive: false \}/);
  assert.match(source, /'gesturestart'/);
  const css = readFileSync(new URL('../../src/components/editor/EditorWindow.css', import.meta.url), 'utf8');
  const rule = /\n\.editor-window-surface \.html-tab-gesture \{([^}]*)\}/.exec(css);
  assert.ok(rule, 'gesture surface rule');
  assert.match(rule[1], /display:\s*none/);
  assert.match(rule[1], /touch-action:\s*none/);
  // Shown only where the primary pointer is a finger; a mouse keeps using the page as before.
  assert.match(css, /@media \(hover: none\) and \(pointer: coarse\) \{\s*\.editor-window-surface \.html-tab-gesture \{ display: block; \}/);
});

// FR-MDE-028 AC-11 (2026-10-28, user report): with the surface over the page, the page could no
// longer be scrolled or clicked. The surface sends drags and taps into the page instead: a helper
// script appended to the text the frame loads (as a draft) scrolls and clicks on the app's word.

test('FR-MDE-028 AC-11: a drag moves the zoomed page first and scrolls the page with what is left', () => {
  // Unzoomed nothing moves, so a drag of 40 px up scrolls the page 40 / 0.25 = 160 page px down.
  const flat = dragHtmlFrame(HTML_FRAME_VIEW_RESET, area, base, 0, -40);
  assert.deepEqual(flat.view, HTML_FRAME_VIEW_RESET);
  near(flat.scrollX, 0, 'scrollX');
  near(flat.scrollY, 160, 'scrollY');
  // Zoomed with room to move, the drag only moves the page.
  const room = dragHtmlFrame({ zoom: 2, x: -100, y: -100 }, area, base, 0, -30);
  assert.deepEqual(room.view, { zoom: 2, x: -100, y: -130 });
  near(room.scrollY, 0, 'no scroll while the page moves');
  // At the bottom edge the rest scrolls, at the zoomed scale: 20 / (0.25 * 2) = 40.
  const edge = dragHtmlFrame({ zoom: 2, x: -100, y: -490 }, area, base, 0, -30);
  assert.deepEqual(edge.view, { zoom: 2, x: -100, y: -500 });
  near(edge.scrollY, 40, 'scroll past the edge');
});

test('FR-MDE-028 AC-11: a tap on the surface is the page point under it', () => {
  assert.deepEqual(framePointOf({ zoom: 2, x: -100, y: -50 }, 0.25, { x: 100, y: 150 }), { x: 400, y: 400 });
});

test('FR-MDE-028 AC-11: the helper is appended to the page text and obeys only the app', () => {
  const page = '<!doctype html><p>x</p>';
  const out = withViewerHelper(page);
  assert.ok(out.startsWith(page));
  assert.match(out, /<script>[\s\S]*<\/script>\s*$/);
  assert.doesNotMatch(HTML_VIEWER_HELPER_SCRIPT, /<\/script/i);

  const scrolled: number[][] = [];
  const clicked: string[] = [];
  let listener: ((event: { source: unknown; data: unknown }) => void) | null = null;
  const parent = {};
  const self = {};
  const button = { focus() {}, click() { clicked.push('button'); }, parentElement: null };
  const body = { parentElement: null };
  const documentStub = { body, documentElement: {}, elementFromPoint: (x: number) => (x === 7 ? button : body) };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('addEventListener', 'parent', 'window', 'document', 'scrollBy', 'getComputedStyle', HTML_VIEWER_HELPER_SCRIPT)(
    (type: string, fn: typeof listener) => { if (type === 'message') listener = fn; },
    parent,
    self,
    documentStub,
    (dx: number, dy: number) => scrolled.push([dx, dy]),
    () => ({ overflowY: 'visible' }),
  );
  assert.ok(listener);
  const send = listener as (event: { source: unknown; data: unknown }) => void;
  send({ source: parent, data: { type: HTML_SCROLL_MESSAGE, x: 1, y: 1, dx: 0, dy: 160 } });
  send({ source: parent, data: { type: HTML_TAP_MESSAGE, x: 7, y: 1 } });
  // The page's own messages, or anything not from the app, do nothing.
  send({ source: self, data: { type: HTML_SCROLL_MESSAGE, x: 1, y: 1, dx: 0, dy: 999 } });
  send({ source: parent, data: 'buildergate-html-scroll' });
  assert.deepEqual(scrolled, [[0, 160]]);
  assert.deepEqual(clicked, ['button']);
});

test('FR-MDE-028 AC-11: on a touch screen the fitted frame loads the text with the helper and gets drags and taps', () => {
  const source = readFileSync(new URL('../../src/components/editor/HtmlFileTab.tsx', import.meta.url), 'utf8');
  assert.match(source, /withViewerHelper\(/);
  assert.match(source, /dragHtmlFrame\(/);
  assert.match(source, /framePointOf\(/);
  assert.match(source, /postMessage\(/);
  assert.match(source, /HTML_SCROLL_MESSAGE/);
  assert.match(source, /HTML_TAP_MESSAGE/);
  assert.match(source, /matchMedia\(TOUCH_SCREEN_QUERY\)/);
});
