import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INITIAL_EDITOR_WINDOW_VIEWPORT_RATIO,
  computeInitialEditorWindowRect,
} from '../../src/components/editor/editorWindowInitialRect.ts';

// FR-MDE-001 — where a window opens when nothing has been stored for it.
//
// A window used to open over the terminal it was launched from. It holds
// documents opened from several terminals now, so it opens against the viewport
// instead: seven tenths of it, centred. The ratio and the centring are the whole
// of this module; reading a stored rect is a separate rule and a later step.

const MIN_SIZE = { width: 320, height: 240 };

test('FR-MDE-001 the initial rect runs with no DOM in scope', () => {
  // The viewport is handed in rather than read, which is what keeps this
  // decidable without a browser. A transition that reached for `window` would
  // throw here rather than pass quietly.
  assert.equal(typeof (globalThis as { window?: unknown }).window, 'undefined');
  computeInitialEditorWindowRect({ width: 1920, height: 1080 }, MIN_SIZE);
});

test('FR-MDE-001 a window opens at seven tenths of the viewport, centred', () => {
  const rect = computeInitialEditorWindowRect({ width: 1920, height: 1080 }, MIN_SIZE);

  assert.deepEqual(rect, { x: 288, y: 162, width: 1344, height: 756 });

  // The ratio is stated once and read from there, so the numbers above and the
  // implementation cannot drift into two different sevenths.
  assert.equal(rect.width, Math.round(1920 * INITIAL_EDITOR_WINDOW_VIEWPORT_RATIO));
  assert.equal(rect.height, Math.round(1080 * INITIAL_EDITOR_WINDOW_VIEWPORT_RATIO));

  // Centred means the margins match on both sides, which a rect that merely
  // started at the right x would not have to satisfy.
  assert.equal(rect.x, 1920 - (rect.x + rect.width));
  assert.equal(rect.y, 1080 - (rect.y + rect.height));

  // A viewport of a different shape, so an implementation that squared the two
  // axes or swapped them lands somewhere else.
  const tall = computeInitialEditorWindowRect({ width: 800, height: 1400 }, MIN_SIZE);
  assert.equal(tall.width, 560);
  assert.equal(tall.height, 980);
  assert.equal(tall.x, 120);
  assert.equal(tall.y, 210);
});

test('FR-MDE-001 the initial rect never falls below the minimum size', () => {
  // Seven tenths of a narrow viewport is under the floor the window agrees to
  // render at, and the floor wins. Both axes are exercised separately, so a
  // clamp applied to one of them alone fails.
  const narrow = computeInitialEditorWindowRect({ width: 400, height: 1080 }, MIN_SIZE);
  assert.equal(narrow.width, MIN_SIZE.width);
  assert.equal(narrow.height, Math.round(1080 * INITIAL_EDITOR_WINDOW_VIEWPORT_RATIO));

  const short = computeInitialEditorWindowRect({ width: 1920, height: 300 }, MIN_SIZE);
  assert.equal(short.width, Math.round(1920 * INITIAL_EDITOR_WINDOW_VIEWPORT_RATIO));
  assert.equal(short.height, MIN_SIZE.height);

  // A viewport smaller than the floor keeps the floor rather than shrinking to
  // fit, and the window is pushed to the origin instead of to a negative
  // coordinate -- part of it is off screen, which is the side this rule takes.
  const tiny = computeInitialEditorWindowRect({ width: 200, height: 150 }, MIN_SIZE);
  assert.equal(tiny.width, MIN_SIZE.width);
  assert.equal(tiny.height, MIN_SIZE.height);
  assert.equal(tiny.x, 0);
  assert.equal(tiny.y, 0);
});

test('FR-MDE-001 a viewport of zero or nonsense still yields a usable rect', () => {
  // The measurement can arrive before layout has happened, and a window placed
  // at a NaN rect never reaches the screen at all.
  [
    { width: 0, height: 0 },
    { width: Number.NaN, height: Number.NaN },
    { width: -100, height: -100 },
  ].forEach((viewport) => {
    const rect = computeInitialEditorWindowRect(viewport, MIN_SIZE);
    assert.equal(rect.width, MIN_SIZE.width, `width for ${JSON.stringify(viewport)}`);
    assert.equal(rect.height, MIN_SIZE.height, `height for ${JSON.stringify(viewport)}`);
    assert.equal(rect.x, 0);
    assert.equal(rect.y, 0);
  });
});
