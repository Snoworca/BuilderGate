// FR-FEX-020 AC-2 (#128): lifting the finger after the long press that opened the mobile menu must
// not close it. The release sends a compatibility mousedown onto the backdrop that has just appeared
// under the finger; only a press that started after the menu opened closes it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { shouldBackdropPressClose } from '../../src/components/ContextMenu/contextMenuModel.ts';

test('FR-FEX-020 AC-2: the mousedown left over from the opening press does not close the menu', () => {
  assert.equal(shouldBackdropPressClose({ onBackdrop: true, pressStartedSinceOpen: false }), false);
});

test('FR-FEX-020 AC-2: a new press on the backdrop closes it; a press inside the dialog never does', () => {
  assert.equal(shouldBackdropPressClose({ onBackdrop: true, pressStartedSinceOpen: true }), true);
  assert.equal(shouldBackdropPressClose({ onBackdrop: false, pressStartedSinceOpen: true }), false);
});

test('FR-FEX-020 AC-2: the mobile backdrop records presses with pointerdown and asks the rule on pointerup', () => {
  const source = readFileSync(new URL('../../src/components/ContextMenu/ContextMenu.tsx', import.meta.url), 'utf8');
  const backdrop = source.slice(source.indexOf('className="context-menu-dialog-backdrop"') - 400, source.indexOf('className="context-menu-dialog"'));
  assert.match(backdrop, /onPointerDown=/);
  assert.match(backdrop, /onPointerUp=\{[\s\S]*shouldBackdropPressClose\(/);
  // A tap whose compatibility mouse events the browser cancels sends no mousedown at all.
  assert.doesNotMatch(backdrop, /onMouseDown=/);
  // A touch that closes the menu cancels its touchend, so no click falls through to what is under it.
  assert.match(backdrop, /pointerType === 'touch'/);
  assert.match(backdrop, /onTouchEnd=\{[\s\S]*event\.preventDefault\(\);\s*closeWithHistory\(\)/);
});
