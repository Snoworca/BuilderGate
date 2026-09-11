import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resolveEditorWindowPlacementMode,
  type EditorWindowPlacementModeInput,
} from '../../src/components/editor/editorWindowPlacementMode.ts';

// FR-MDE-001 — whether the window is placed by the user or by the layout.
//
// On a mobile layout it fills the stage and neither reads nor writes the cached
// position. The cache is one value shared by every window, so a full-screen
// rect written from a phone would be inherited by the next desktop window.

function input(overrides: Partial<EditorWindowPlacementModeInput> = {}): EditorWindowPlacementModeInput {
  return { isMobile: false, ...overrides };
}

test('FR-MDE-001 the placement mode runs with no DOM in scope', () => {
  assert.equal(typeof (globalThis as { window?: unknown }).window, 'undefined');
  resolveEditorWindowPlacementMode(input());
  resolveEditorWindowPlacementMode(input({ isMobile: true }));
});

test('FR-MDE-001 a desktop layout places the window and uses the cache', () => {
  const mode = resolveEditorWindowPlacementMode(input());

  assert.equal(mode.placement, 'floating');
  assert.equal(mode.usesGeometryCache, true);
  assert.equal(mode.draggable, true);
});

test('FR-MDE-001 a mobile layout fills the stage and leaves the cache alone', () => {
  const mode = resolveEditorWindowPlacementMode(input({ isMobile: true }));

  // `stage` is the placement that fills the stage, which is what "full screen"
  // means for a window confined to it.
  assert.equal(mode.placement, 'stage');

  // Neither read nor written. Read alone would be harmless; written is what
  // would leak a phone-sized rect into the next desktop session, and one flag
  // covers both because there is no case for doing one without the other.
  assert.equal(mode.usesGeometryCache, false);

  // A window that fills the screen has nowhere to be dragged to, and a drag
  // would emit a rect -- which is the write this is keeping away from.
  assert.equal(mode.draggable, false);
});

test('FR-MDE-001 the two layouts differ in every field', () => {
  // Without this, a mode object that answered the same way for both would
  // satisfy each case above on its own. The fields are compared as a whole so
  // a field added later is covered without editing this.
  const desktop = resolveEditorWindowPlacementMode(input());
  const mobile = resolveEditorWindowPlacementMode(input({ isMobile: true }));

  Object.keys(desktop).forEach((field) => {
    assert.notEqual(
      desktop[field as keyof typeof desktop],
      mobile[field as keyof typeof mobile],
      `${field} should differ between the two layouts`,
    );
  });
});
