import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INITIAL_EDITOR_WINDOW_VIEWPORT_RATIO,
  computeInitialEditorWindowRect,
} from '../../src/components/editor/editorWindowInitialRect.ts';

// FR-MDE-001 — where a window opens when nothing has been stored for it.
//
// A window used to open over the terminal it was launched from. It holds
// documents opened from several terminals now, so its size comes from the
// viewport instead: seven tenths of it.
//
// The size and the position come from two different boxes, and that is the
// subject of this module. The ratio is taken against the viewport because the
// window is no longer sized against any one terminal's area. The centring is
// done inside the box the window is actually confined to -- the stage, which
// excludes the sidebar, the header and the tab bar -- because centring against
// the viewport and then being confined to a smaller box does not leave the
// window centred; it leaves it pushed against that box's near edge.

const MIN_SIZE = { width: 320, height: 240 };

// A desktop layout: the stage sits inside the viewport, offset by the sidebar
// on the left and the header and tab bar above.
const VIEWPORT = { width: 1280, height: 720 };
const STAGE = { left: 220, top: 94, width: 1060, height: 626 };

test('FR-MDE-001 the initial rect runs with no DOM in scope', () => {
  // Both boxes are handed in rather than measured here, which is what keeps
  // this decidable without a browser.
  assert.equal(typeof (globalThis as { window?: unknown }).window, 'undefined');
  computeInitialEditorWindowRect(VIEWPORT, STAGE, MIN_SIZE);
});

test('FR-MDE-001 the size is seven tenths of the viewport', () => {
  const rect = computeInitialEditorWindowRect(VIEWPORT, STAGE, MIN_SIZE);

  // The ratio is stated once and read from there, so the numbers here and the
  // implementation cannot drift into two different sevenths.
  assert.equal(rect.width, Math.round(1280 * INITIAL_EDITOR_WINDOW_VIEWPORT_RATIO));
  assert.equal(rect.height, Math.round(720 * INITIAL_EDITOR_WINDOW_VIEWPORT_RATIO));
  assert.equal(rect.width, 896);
  assert.equal(rect.height, 504);

  // Taken against the viewport, not against the stage. The stage is smaller in
  // both axes here, so a ratio applied to it would give different numbers.
  assert.notEqual(rect.width, Math.round(STAGE.width * INITIAL_EDITOR_WINDOW_VIEWPORT_RATIO));
  assert.notEqual(rect.height, Math.round(STAGE.height * INITIAL_EDITOR_WINDOW_VIEWPORT_RATIO));
});

test('FR-MDE-001 the window is centred inside the stage, not inside the viewport', () => {
  const rect = computeInitialEditorWindowRect(VIEWPORT, STAGE, MIN_SIZE);

  // Centred in the stage means the margins match on both sides of the stage.
  assert.equal(rect.x - STAGE.left, (STAGE.left + STAGE.width) - (rect.x + rect.width));
  assert.equal(rect.y - STAGE.top, (STAGE.top + STAGE.height) - (rect.y + rect.height));
  assert.deepEqual(rect, { x: 302, y: 155, width: 896, height: 504 });

  // And the viewport centre is a different number, so this case tells the two
  // apart rather than passing under either reading. 192 is where centring
  // against the viewport would put it, and the stage's own left edge -- 220 --
  // is where the layer's clamp pushes such a rect, which is the failure this
  // module exists to avoid.
  assert.notEqual(rect.x, Math.round((VIEWPORT.width - rect.width) / 2));
  assert.notEqual(rect.x, STAGE.left);
});

test('FR-MDE-001 a window wider than the stage is confined to it', () => {
  // Seven tenths of a wide viewport can still exceed a narrow stage, and the
  // window has to fit the box it is confined to or the layer's clamp moves it
  // afterwards -- which is the same displacement all over again.
  const narrowStage = { left: 900, top: 94, width: 360, height: 626 };
  const rect = computeInitialEditorWindowRect(VIEWPORT, narrowStage, MIN_SIZE);

  assert.equal(rect.width, narrowStage.width);
  assert.equal(rect.x, narrowStage.left);
  // The other axis is untouched by that, so a clamp applied to both at once
  // fails here.
  assert.equal(rect.height, 504);
});

test('FR-MDE-001 the minimum size wins over confinement', () => {
  // A stage smaller than the floor keeps the floor rather than shrinking to
  // fit. Part of the window then sits outside the stage, which is the side
  // U-8 takes: a window shrunk under its own minimum cannot show its title
  // bar, and a window whose title bar is gone cannot be moved back.
  const tinyStage = { left: 220, top: 94, width: 200, height: 150 };
  const rect = computeInitialEditorWindowRect(VIEWPORT, tinyStage, MIN_SIZE);

  assert.equal(rect.width, MIN_SIZE.width);
  assert.equal(rect.height, MIN_SIZE.height);
  assert.equal(rect.x, tinyStage.left);
  assert.equal(rect.y, tinyStage.top);

  // The same floor applies when it is the viewport that is small, which is
  // where the size comes from.
  const narrowViewport = computeInitialEditorWindowRect(
    { width: 400, height: 300 },
    STAGE,
    MIN_SIZE,
  );
  assert.equal(narrowViewport.width, MIN_SIZE.width);
  assert.equal(narrowViewport.height, MIN_SIZE.height);
});

test('FR-MDE-001 a box of zero or nonsense still yields a usable rect', () => {
  // A measurement can arrive before layout has happened, and a window placed
  // at a NaN rect never reaches the screen at all.
  const broken = [
    { width: 0, height: 0 },
    { width: Number.NaN, height: Number.NaN },
    { width: -100, height: -100 },
  ];

  broken.forEach((viewport) => {
    const rect = computeInitialEditorWindowRect(viewport, STAGE, MIN_SIZE);
    assert.equal(rect.width, MIN_SIZE.width, `width for viewport ${JSON.stringify(viewport)}`);
    assert.equal(rect.height, MIN_SIZE.height, `height for viewport ${JSON.stringify(viewport)}`);
  });

  broken.forEach((size) => {
    const rect = computeInitialEditorWindowRect(VIEWPORT, { left: 0, top: 0, ...size }, MIN_SIZE);
    assert.equal(rect.x, 0, `x for stage ${JSON.stringify(size)}`);
    assert.equal(rect.y, 0, `y for stage ${JSON.stringify(size)}`);
    assert.equal(rect.width, MIN_SIZE.width);
    assert.equal(rect.height, MIN_SIZE.height);
  });

  // A stage whose origin is not a number is treated as the viewport origin
  // rather than propagated into the rect.
  const brokenOrigin = computeInitialEditorWindowRect(
    VIEWPORT,
    { left: Number.NaN, top: Number.NaN, width: 1060, height: 626 },
    MIN_SIZE,
  );
  assert.equal(Number.isFinite(brokenOrigin.x), true);
  assert.equal(Number.isFinite(brokenOrigin.y), true);
});
