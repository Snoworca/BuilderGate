// FR-FEX-032: how the explorer window and tab bar wire the pick-up. The timing stays in
// useLongPress (the explorer may not time a press itself, see fileExplorerInteractionWiring),
// the double tap in useDoubleTap, and a picked drop reuses the FR-FEX-030 drop path.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const windowSource = readFileSync(new URL('../../src/components/fileExplorer/FileExplorerWindow.tsx', import.meta.url), 'utf8');
const tabBarSource = readFileSync(new URL('../../src/components/fileExplorer/FileExplorerTabBar.tsx', import.meta.url), 'utf8');
const interactionSource = readFileSync(new URL('../../src/components/fileExplorer/fileRowInteraction.ts', import.meta.url), 'utf8');

function body(source: string, name: string): string {
  const at = source.indexOf(`const ${name}`);
  assert.ok(at >= 0, `${name} is defined`);
  return source.slice(at, source.indexOf('\n  };', at));
}

// @req FR-FEX-032
test('FR-FEX-032 AC-1/AC-7: one useLongPress of PICK_HOLD_MS picks up, fed by touches and by mouse pointers', () => {
  assert.match(windowSource, /useLongPress\(handlePickHold, PICK_HOLD_MS, \{ doubleTap: false \}\)/);
  assert.match(body(windowSource, 'handlePickHold'), /startPick\(/);
  assert.match(body(windowSource, 'handlePickHold'), /setCurrentInternalDrag\(/);
  assert.match(body(windowSource, 'handleTouchStart'), /pickPress\.onTouchStart\(event\)/);
  assert.match(body(windowSource, 'handleTouchMove'), /pickPress\.onTouchMove\(event\)/);
  assert.match(body(windowSource, 'handleTouchEnd'), /pickPress\.onTouchEnd\(event\)/);
  const down = body(windowSource, 'handleRowsPointerDown');
  assert.match(down, /pointerType !== 'touch'/, 'a touch is timed through the touch events only');
  assert.match(down, /pickPress\.onPointerDown\(event\)/);
  assert.match(windowSource, /onPointerMove=\{handleRowsPointerMove\}/);
  assert.match(windowSource, /onPointerUp=\{handleRowsPointerUp\}/);
  assert.match(windowSource, /onPointerCancel=\{handleRowsPointerUp\}/);
});

// @req FR-FEX-032
test('FR-FEX-032 AC-7: a mouse that moves first starts the FR-FEX-030 drag; a picked row starts no native drag', () => {
  const start = body(windowSource, 'handleRowDragStart');
  assert.match(start, /pickPress\.onPointerUp\(\)/, 'the native drag cancels the pending pick');
  assert.match(start, /pickRef\.current !== null/, 'during a pick the native drag is refused');
});

// @req FR-FEX-032
test('FR-FEX-032 AC-1: the carried rows leave the list through a style, not classes React would overwrite', () => {
  assert.match(windowSource, /hiddenRowsCss\(pickedPaths/);
  assert.match(windowSource, /<style>\{/);
});

// @req FR-FEX-032
test('FR-FEX-032 AC-2/AC-3: rows, path bar and tabs take a picked drop through the FR-FEX-030 rules', () => {
  for (const name of [PICK_EVENT_NAMES.over, PICK_EVENT_NAMES.leave, PICK_EVENT_NAMES.drop]) {
    assert.ok(windowSource.includes(name), `the window listens for ${name}`);
    assert.ok(tabBarSource.includes(name), `the tab bar listens for ${name}`);
  }
  assert.match(windowSource, /handleInternalDragOver\(/);
  assert.match(windowSource, /dropInternal\(/);
  assert.match(tabBarSource, /springDelay\(\{ kind: 'tab', active: selected \}\)/);
});

const PICK_EVENT_NAMES = { over: 'PICK_EVENT.over', leave: 'PICK_EVENT.leave', drop: 'PICK_EVENT.drop' };

// @req FR-FEX-032
test('FR-FEX-032 AC-5: a touch released in place opens the row menu through the contextmenu path', () => {
  const hold = body(windowSource, 'handlePickHold');
  assert.match(hold, /kind === 'menu'/);
  assert.match(windowSource, /new MouseEvent\('contextmenu'/);
});

// @req FR-FEX-032
test('FR-FEX-032 AC-6: a double tap on a row opens it as a double click; the 1.5 s hold is gone', () => {
  assert.match(windowSource, /useDoubleTap\(handleDoubleTapOpen\)/);
  assert.match(body(windowSource, 'handleDoubleTapOpen'), /new MouseEvent\('dblclick'/);
  assert.match(body(windowSource, 'handleTouchStart'), /openTap\.onTouchStart\(event\)/);
  assert.match(body(windowSource, 'handleTouchEnd'), /openTap\.onTouchEnd\(event\)/);
  assert.doesNotMatch(windowSource, /LONG_PRESS_OPEN_MS|handleLongHoldOpen/);
  assert.doesNotMatch(interactionSource, /LONG_PRESS_OPEN_MS/);
  assert.doesNotMatch(windowSource, /useLongPress\(handleLongPress, LONG_PRESS_MENU_MS\)/, 'a row hold no longer opens the menu at 0.5 s');
});
