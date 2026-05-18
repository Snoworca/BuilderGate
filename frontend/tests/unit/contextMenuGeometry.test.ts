import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getContextMenuViewportLimits,
  placeRootContextMenu,
  placeSubContextMenu,
} from '../../src/components/ContextMenu/contextMenuGeometry.ts';

test('placeRootContextMenu clamps right and bottom overflow inside viewport', () => {
  assert.deepEqual(
    placeRootContextMenu(
      { x: 790, y: 590 },
      { width: 180, height: 120 },
      { width: 800, height: 600 },
    ),
    { left: 612, top: 472, maxWidth: 784, maxHeight: 584 },
  );
});

test('placeSubContextMenu flips to the left when right edge overflows', () => {
  assert.deepEqual(
    placeSubContextMenu(
      { left: 700, top: 100, width: 80, height: 30 },
      { width: 160, height: 200 },
      { width: 800, height: 600 },
    ),
    { left: 538, top: 100, maxWidth: 784, maxHeight: 584 },
  );
});

test('placeSubContextMenu clamps top after horizontal placement', () => {
  assert.deepEqual(
    placeSubContextMenu(
      { left: 20, top: -40, width: 80, height: 30 },
      { width: 160, height: 120 },
      { width: 800, height: 600 },
    ),
    { left: 102, top: 8, maxWidth: 784, maxHeight: 584 },
  );
});

test('placeSubContextMenu flips left and clamps when flipped position is outside viewport', () => {
  assert.deepEqual(
    placeSubContextMenu(
      { left: 740, top: 100, width: 60, height: 30 },
      { width: 760, height: 200 },
      { width: 800, height: 600 },
    ),
    { left: 8, top: 100, maxWidth: 784, maxHeight: 584 },
  );
});

test('viewport limits force scrollable menu bounds for oversized content', () => {
  assert.deepEqual(
    getContextMenuViewportLimits({ width: 320, height: 240 }),
    { maxWidth: 304, maxHeight: 224 },
  );
  assert.deepEqual(
    placeRootContextMenu(
      { x: 0, y: 0 },
      { width: 600, height: 600 },
      { width: 320, height: 240 },
    ),
    { left: 8, top: 8, maxWidth: 304, maxHeight: 224 },
  );
});

test('placeSubContextMenu returns scrollable bounds when viewport is smaller than submenu content', () => {
  assert.deepEqual(
    placeSubContextMenu(
      { left: 90, top: 70, width: 40, height: 20 },
      { width: 300, height: 200 },
      { width: 120, height: 80 },
    ),
    { left: 8, top: 8, maxWidth: 104, maxHeight: 64 },
  );
});
