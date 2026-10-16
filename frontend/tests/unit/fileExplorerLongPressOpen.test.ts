// FR-FEX-020 (#128): holding a row for 1.5 s on a touch screen opens it, as a double tap does.
// The timing lives in useLongPress (the explorer may not time a press itself, see
// fileExplorerInteractionWiring.test.ts); what this pins is the threshold and that the window
// routes the hold through the views' own double-click path.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LONG_PRESS_MENU_MS, LONG_PRESS_OPEN_MS } from '../../src/components/fileExplorer/fileRowInteraction.ts';

const windowSource = readFileSync(new URL('../../src/components/fileExplorer/FileExplorerWindow.tsx', import.meta.url), 'utf8');

test('FR-FEX-020 AC-1/AC-2: the menu press stays at 0.5 s and the open press is 1.5 s', () => {
  assert.equal(LONG_PRESS_MENU_MS, 500);
  assert.equal(LONG_PRESS_OPEN_MS, 1500);
});

test('FR-FEX-020 AC-1: the window holds a second press of LONG_PRESS_OPEN_MS that raises a dblclick', () => {
  assert.match(windowSource, /useLongPress\(\s*handleLongPress\s*,\s*LONG_PRESS_MENU_MS\s*\)/);
  assert.match(windowSource, /useLongPress\(\s*handleLongHoldOpen\s*,\s*LONG_PRESS_OPEN_MS\s*\)/);
  const handler = windowSource.slice(windowSource.indexOf('const handleLongHoldOpen'), windowSource.indexOf('const longPress ='));
  assert.match(handler, /new MouseEvent\('dblclick'/, 'the hold goes through the double-click path the views already handle');
  assert.match(handler, /setMenu\(null\)/, 'AC-2: the menu the 0.5 s press opened closes');
});

test('FR-FEX-020 AC-3: start, move and end reach both presses, so a scroll or a release cancels the open', () => {
  for (const name of ['handleTouchStart', 'handleTouchMove', 'handleTouchEnd']) {
    const at = windowSource.indexOf(`const ${name}`);
    assert.ok(at >= 0, `${name} is defined`);
    const body = windowSource.slice(at, windowSource.indexOf('};', at));
    assert.match(body, /longPress\.onTouch/, `${name} feeds the menu press`);
    assert.match(body, /longHoldOpen\.onTouch/, `${name} feeds the open press`);
  }
  assert.match(windowSource, /onTouchMove=\{handleTouchMove\}/);
  assert.match(windowSource, /onTouchEnd=\{handleTouchEnd\}/);
});
