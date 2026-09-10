import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ICON_GLYPHS,
  isIconName,
  resolveToggleIcon,
  type IconName,
} from '../../src/components/common/iconGlyphs.ts';

// The shared icon vocabulary the title bar and the header draw through, and the
// one rule a two-state button applies. Both are values rather than markup, so
// the vocabulary and the toggle can be judged without a DOM -- what is left for
// Playwright is that the button carries the glyph onto the screen.

const REQUIRED: IconName[] = ['save', 'terminal', 'maximize', 'restore', 'minimize', 'document'];

test('every button the editor title bar draws has a glyph', () => {
  for (const name of REQUIRED) {
    assert.equal(isIconName(name), true, `${name} is not a known icon`);
    const glyph = ICON_GLYPHS[name];
    assert.ok(glyph.paths.length > 0, `${name} carries no path`);
  }
});

test('glyph paths are SVG path data, not letters', () => {
  // The defect this replaces was a title bar of bare capitals. A path that does
  // not start with a move command is not a drawing.
  for (const [name, glyph] of Object.entries(ICON_GLYPHS)) {
    for (const d of glyph.paths) {
      assert.match(d, /^M/, `${name} has a path that does not begin with a move`);
    }
  }
});

test('maximize and restore are different drawings', () => {
  // A toggle whose two states drew the same thing would say nothing about which
  // state it is in, which is the whole point of the toggle.
  assert.notDeepEqual(ICON_GLYPHS.maximize.paths, ICON_GLYPHS.restore.paths);
});

test('a toggle draws the glyph of the state it is in', () => {
  // Pressed means maximized. The accessible name stays put and `aria-pressed`
  // carries the state, so the drawing is the only thing that moves.
  assert.equal(resolveToggleIcon(true, { on: 'restore', off: 'maximize' }), 'restore');
  assert.equal(resolveToggleIcon(false, { on: 'restore', off: 'maximize' }), 'maximize');
});

test('an unknown name is refused rather than drawn empty', () => {
  assert.equal(isIconName('floppy'), false);
  assert.equal(isIconName(''), false);
});
