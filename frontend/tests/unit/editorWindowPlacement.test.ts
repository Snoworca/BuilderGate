import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { DialogRect } from '../../src/components/dialog/types.ts';
import {
  createEditorWindowPlacementState,
  enterFloating,
  toggleMaximize,
} from '../../src/components/editor/editorWindowPlacement.ts';

// FR-MDE-001 — the placement state machine only (AC-1, AC-2). The rect a window
// occupies in `stage` is computed elsewhere; what this module owns is which of the
// two placement states the window is in, which placement `최대화` remembers, and
// the rect `floating` inherits on entry. `minimized` is a separate axis and is
// deliberately absent here.
//
// The union used to carry a third state, `docked`, in which the window covered one
// terminal's area, and the title bar carried a `터미널 채움` control that put it
// there. Both are gone: a window holds documents opened from several terminals and
// there is no single terminal for it to cover.

const FLOATING_RECT: DialogRect = { x: 320, y: 152, width: 640, height: 452 };
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
  assert.equal(state.placement, 'stage');
  assert.equal(state.placementBeforeStage, null);
  assert.equal(state.floatingRect, null);

  // Every export is called here, so the claim above covers the module rather
  // than whichever functions the other tests happen to reach.
  toggleMaximize(state);
  enterFloating(state, FLOATING_RECT);
});

test('FR-MDE-001 maximize records the previous placement and toggles back to it', () => {
  const floating = enterFloating(createEditorWindowPlacementState(), FLOATING_RECT);

  const maximized = toggleMaximize(floating);
  assert.equal(maximized.placement, 'stage');
  assert.equal(maximized.placementBeforeStage, 'floating');

  // A transition that edited its input in place and handed the same object
  // back would satisfy every value assertion above while giving React nothing
  // to re-render on, so the source state and the identity are pinned too.
  assert.notEqual(maximized, floating);
  assert.deepEqual(floating, {
    placement: 'floating',
    placementBeforeStage: null,
    floatingRect: FLOATING_RECT,
  });

  // Returning to `floating` without the rect it held would drop the window
  // somewhere the user never put it.
  const restored = toggleMaximize(maximized);
  assert.notEqual(restored, maximized);
  assert.equal(restored.placement, 'floating');
  assert.equal(restored.placementBeforeStage, null);
  assert.deepEqual(restored.floatingRect, FLOATING_RECT);
});

test('FR-MDE-001 maximize from stage with no record falls back to floating', () => {
  // A window opens into `stage` and a restored window can arrive there with nothing
  // recorded. `docked` used to be the destination in that case; `floating` is the
  // only other placement left, so the toggle has one answer.
  const stageWithoutRecord = createEditorWindowPlacementState();
  assert.equal(stageWithoutRecord.placement, 'stage');
  assert.equal(stageWithoutRecord.placementBeforeStage, null);

  const next = toggleMaximize(stageWithoutRecord);
  assert.equal(next.placement, 'floating');
  assert.equal(next.placementBeforeStage, null);
});

test('FR-MDE-001 drag or resize enters floating inheriting the previous rect', () => {
  const fromStage = enterFloating(createEditorWindowPlacementState(), STAGE_RECT);
  assert.equal(fromStage.placement, 'floating');
  assert.deepEqual(fromStage.floatingRect, STAGE_RECT);
  // Storing the caller's own object would let a later drag mutate the state
  // through it, and deepEqual alone cannot tell a copy from an alias.
  assert.notEqual(fromStage.floatingRect, STAGE_RECT);

  // Dragging a window that is already floating moves it to the new rect.
  const draggedAgain = enterFloating(fromStage, FLOATING_RECT);
  assert.equal(draggedAgain.placement, 'floating');
  assert.deepEqual(draggedAgain.floatingRect, FLOATING_RECT);

  // The record only ever describes what `stage` was entered from, so leaving
  // for `floating` has to clear it. Keeping it would make a later 최대화 offer
  // a destination the window never came from.
  const maximized = toggleMaximize(enterFloating(createEditorWindowPlacementState(), FLOATING_RECT));
  assert.equal(maximized.placementBeforeStage, 'floating');
  const draggedFromStage = enterFloating(maximized, STAGE_RECT);
  assert.equal(draggedFromStage.placementBeforeStage, null);
});

// The union and the terminal-fill control are source-text facts: a value cannot be
// asked whether a third member of its own type still exists. Reading the module
// text is what makes their removal checkable at all.
const PLACEMENT_SOURCE = readFileSync(
  new URL('../../src/components/editor/editorWindowPlacement.ts', import.meta.url),
  'utf8',
);

// Comments are stripped before the negative assertions below run. The module's own
// comments say what `docked` was and why it went, and a bare search for the word
// would be failed by that explanation -- which would make the assertion demand the
// explanation be deleted.
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

test('FR-MDE-001 the placement union carries stage and floating and nothing else', () => {
  // The union declaration is located before anything is asserted about its
  // contents. Without this a renamed type would make the match below fail to find
  // anything, and a negative assertion over an empty string passes for free.
  const code = withoutComments(PLACEMENT_SOURCE);
  const union = /export type EditorWindowPlacement =([^;]*);/.exec(code);
  assert.notEqual(union, null, 'the placement union is still declared here');

  const members = (union as RegExpExecArray)[1]
    .split('|')
    .map((member) => member.trim().replace(/^'|'$/g, ''))
    .filter((member) => member.length > 0);
  assert.deepEqual(members.sort(), ['floating', 'stage']);

  // And the control that existed to reach the removed member is gone with it.
  // Both names are checked, since either one left behind would keep a caller
  // compiling against a placement the union no longer has.
  assert.doesNotMatch(code, /\bfillTerminal\b/);
  assert.doesNotMatch(code, /\bisTerminalFillDisabled\b/);
  assert.doesNotMatch(code, /\bdocked\b/);
});

// The title bar carried five controls and now carries four. Which of them the
// browser actually renders is judged by the Playwright suite; what is judged here
// is that the removed one has no render site left to reach.
const WINDOW_SOURCE = readFileSync(
  new URL('../../src/components/editor/EditorWindow.tsx', import.meta.url),
  'utf8',
);

test('FR-MDE-001 the title bar offers save, maximize and minimize', () => {
  // The actions block is located first, so the labels below are read from the
  // element that renders them rather than from anywhere in the file -- and so a
  // renamed block fails here instead of making the negative assertion vacuous.
  const actionsStart = WINDOW_SOURCE.indexOf('const titlebarActions = (');
  assert.notEqual(actionsStart, -1, 'the title bar actions are still built here');
  const actionsEnd = WINDOW_SOURCE.indexOf('\n  );', actionsStart);
  assert.notEqual(actionsEnd, -1, 'the actions block is still closed');

  const actions = WINDOW_SOURCE.slice(actionsStart, actionsEnd);
  const labels = Array.from(actions.matchAll(/\blabel="([^"]+)"/g), (match) => match[1]);

  // Three here plus the close button `WindowDialog` draws for every dialog, which
  // is the four the title bar carries. `터미널 채움` was the fifth.
  assert.deepEqual(labels, ['저장', '최대화', '최소화']);

  // The props the removed control was wired through are gone too. A prop left
  // behind would keep `App` passing a callback that nothing calls.
  assert.doesNotMatch(WINDOW_SOURCE, /terminalFillDisabled/);
  assert.doesNotMatch(WINDOW_SOURCE, /onFillTerminal/);
});
