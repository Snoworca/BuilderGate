import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { HTML_FIT_WIDTH, canFitHtmlFrame, htmlFrameLayout } from '../../src/components/editor/htmlTabModel.ts';

// FR-MDE-028 AC-10: on a narrow view a desktop design reflowed and the phone enlarged its text, so
// it looked nothing like it does on a PC (user report 2026-10-28). Below 1280 px the page is laid
// out 1280 px wide and scaled down to the view; a toggle shows the page at the real width instead.

test('FR-MDE-028 AC-10: the fit width is 1280 px', () => {
  assert.equal(HTML_FIT_WIDTH, 1280);
});

test('FR-MDE-028 AC-10: a narrow view lays the page out 1280 px wide and scales it to the view', () => {
  const layout = htmlFrameLayout({ width: 360, height: 500 }, 'fit');
  assert.ok(layout);
  assert.equal(layout.width, 1280);
  assert.equal(layout.scale, 360 / 1280);
  // Scaled back down, the frame is exactly as tall as the view.
  assert.ok(Math.abs(layout.height * layout.scale - 500) < 1);
});

test('FR-MDE-028 AC-10: the real-width choice, a view 1280 px or wider and an unmeasured view keep the plain frame', () => {
  assert.equal(htmlFrameLayout({ width: 360, height: 500 }, 'actual'), null);
  assert.equal(htmlFrameLayout({ width: 1280, height: 700 }, 'fit'), null);
  assert.equal(htmlFrameLayout({ width: 1600, height: 700 }, 'fit'), null);
  assert.equal(htmlFrameLayout({ width: 0, height: 0 }, 'fit'), null);
});

test('FR-MDE-028 AC-10: the toggle is offered only while the view is narrower than the fit width', () => {
  assert.equal(canFitHtmlFrame(318), true);
  assert.equal(canFitHtmlFrame(1279), true);
  assert.equal(canFitHtmlFrame(1280), false);
  assert.equal(canFitHtmlFrame(0), false);
});

test('FR-MDE-028 AC-10: the HTML tab measures its frame area, scales the frame and shows the toggle', () => {
  const source = readFileSync(new URL('../../src/components/editor/HtmlFileTab.tsx', import.meta.url), 'utf8');
  assert.match(source, /htmlFrameLayout\(/);
  assert.match(source, /ResizeObserver/);
  assert.match(source, /transform: htmlFrameTransform\(shownView, frameLayout\.scale\)/);
  assert.match(source, /canFitHtmlFrame\(/);
  assert.match(source, /t\('editor\.html\.fitWidth'\)/);
});
