import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DialogRect } from '../../src/components/dialog/types.ts';
import {
  createEditorWindowPlacementState,
  enterFloating,
  fillTerminal,
  isTerminalFillDisabled,
  toggleMaximize,
} from '../../src/components/editor/editorWindowPlacement.ts';

// FR-MDE-001 — the placement state machine only (AC-1, AC-2, AC-4, plus the
// state-machine half of AC-3 whose rendered disabled attribute is E2E). The rect a
// window occupies in `docked` and in `stage` is computed elsewhere; what this
// module owns is which of the three placement states the window is in, which
// placement `최대화` remembers, and the rect `floating` inherits on entry.
// `minimized` is a separate axis and is deliberately absent here.

const DOCKED_RECT: DialogRect = { x: 320, y: 152, width: 640, height: 452 };
const STAGE_RECT: DialogRect = { x: 220, y: 94, width: 1700, height: 906 };

// The DoD for this module is that no transition reaches the DOM. This suite is
// the check: node:test runs it with no DOM globals installed, so a transition
// that touched one would throw a ReferenceError rather than pass quietly. The
// assertion below pins that precondition, so the DoD does not rest on an
// environment fact nobody measured.
test('FR-MDE-001 the placement transitions run with no DOM in scope', () => {
  assert.equal(typeof (globalThis as { document?: unknown }).document, 'undefined');
  assert.equal(typeof (globalThis as { window?: unknown }).window, 'undefined');

  const state = createEditorWindowPlacementState();
  assert.equal(state.placement, 'docked');
  assert.equal(state.placementBeforeStage, null);
  assert.equal(state.floatingRect, null);

  // Every export is called here, so the claim above covers the module rather
  // than whichever functions the other tests happen to reach.
  toggleMaximize(state);
  fillTerminal(state);
  isTerminalFillDisabled(state);
  enterFloating(state, DOCKED_RECT);
});

test('FR-MDE-001 maximize records the previous placement and toggles back to it', () => {
  const docked = createEditorWindowPlacementState('docked');

  const maximized = toggleMaximize(docked);
  assert.equal(maximized.placement, 'stage');
  assert.equal(maximized.placementBeforeStage, 'docked');

  // A transition that edited its input in place and handed the same object
  // back would satisfy every value assertion above while giving React nothing
  // to re-render on, so the source state and the identity are pinned too.
  assert.notEqual(maximized, docked);
  assert.deepEqual(docked, {
    placement: 'docked',
    placementBeforeStage: null,
    floatingRect: null,
  });

  const restored = toggleMaximize(maximized);
  assert.notEqual(restored, maximized);
  assert.equal(restored.placement, 'docked');
  assert.equal(restored.placementBeforeStage, null);

  // The same toggle has to round-trip a floating window, and returning to
  // `floating` without the rect it held would drop the window somewhere the
  // user never put it.
  const floating = enterFloating(createEditorWindowPlacementState('docked'), DOCKED_RECT);
  const floatingMaximized = toggleMaximize(floating);
  assert.equal(floatingMaximized.placement, 'stage');
  assert.equal(floatingMaximized.placementBeforeStage, 'floating');

  const backToFloating = toggleMaximize(floatingMaximized);
  assert.equal(backToFloating.placement, 'floating');
  assert.equal(backToFloating.placementBeforeStage, null);
  assert.deepEqual(backToFloating.floatingRect, DOCKED_RECT);
});

test('FR-MDE-001 maximize from stage with no record falls back to docked', () => {
  const stageWithoutRecord = createEditorWindowPlacementState('stage');
  assert.equal(stageWithoutRecord.placementBeforeStage, null);

  const next = toggleMaximize(stageWithoutRecord);
  assert.equal(next.placement, 'docked');
  assert.equal(next.placementBeforeStage, null);
});

test('FR-MDE-001 drag or resize enters floating inheriting the previous rect', () => {
  const fromDocked = enterFloating(createEditorWindowPlacementState('docked'), DOCKED_RECT);
  assert.equal(fromDocked.placement, 'floating');
  assert.deepEqual(fromDocked.floatingRect, DOCKED_RECT);
  // Storing the caller's own object would let a later drag mutate the state
  // through it, and deepEqual alone cannot tell a copy from an alias.
  assert.notEqual(fromDocked.floatingRect, DOCKED_RECT);

  const fromStage = enterFloating(createEditorWindowPlacementState('stage'), STAGE_RECT);
  assert.equal(fromStage.placement, 'floating');
  assert.deepEqual(fromStage.floatingRect, STAGE_RECT);

  // The record only ever describes what `stage` was entered from, so leaving
  // for `floating` has to clear it. Keeping it would make a later 최대화 offer
  // a destination the window never came from.
  const maximized = toggleMaximize(createEditorWindowPlacementState('docked'));
  const draggedFromStage = enterFloating(maximized, STAGE_RECT);
  assert.equal(draggedFromStage.placementBeforeStage, null);
});

// The rendered disabled attribute is judged by the Playwright suite, because
// only a browser can see it. What is judged here is the ground that suite
// renders from: which placements the control acts on, and where it lands.
test('FR-MDE-001 the terminal fill control lands on docked and reports itself disabled there', () => {
  const stage = toggleMaximize(createEditorWindowPlacementState('docked'));
  assert.equal(isTerminalFillDisabled(stage), false);

  const filledFromStage = fillTerminal(stage);
  assert.equal(filledFromStage.placement, 'docked');
  assert.equal(filledFromStage.placementBeforeStage, null);
  assert.equal(isTerminalFillDisabled(filledFromStage), true);

  const floating = enterFloating(createEditorWindowPlacementState('docked'), DOCKED_RECT);
  assert.equal(isTerminalFillDisabled(floating), false);
  assert.equal(fillTerminal(floating).placement, 'docked');

  assert.notEqual(filledFromStage, stage);
});
