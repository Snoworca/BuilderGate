import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  createEditorWindowPlacementState,
  enterFloating,
  toggleMaximize,
  type EditorWindowPlacementState,
} from '../../src/components/editor/editorWindowPlacement.ts';
import {
  isEditorWindowVisible,
  minimizeEditorWindow,
  restoreEditorWindow,
  type EditorWindowHidingState,
  type EditorWindowVisibilityInput,
} from '../../src/components/editor/editorWindowVisibility.ts';

// FR-MDE-002 — the three-term visibility conjunction and the hiding axis, as pure
// functions. AC-3 (placement survives minimize and restore) and AC-4 (each of the
// three terms alone hides the window) are decided here; AC-1, AC-2, AC-6 and AC-7
// all require a mounted editor and belong to the Playwright suite, because this
// suite has no DOM to mount one into.
//
// The two terms this predicate used to carry -- the bound terminal tab, and the
// usable terminal area a `docked` window needed -- are gone. A window is no longer
// scoped to one terminal tab, so the cases below assert the positive form of that:
// switching terminal tabs leaves the window on screen.

// Every term holds here. Each case below falsifies exactly one field of this base,
// which is what lets a failure name the term it came from.
function visibleInput(
  overrides: Partial<EditorWindowVisibilityInput> = {},
): EditorWindowVisibilityInput {
  return {
    minimized: false,
    screen: 'workspace',
    activeWorkspaceId: 'ws-active',
    windowWorkspaceId: 'ws-active',
    ...overrides,
  };
}

function hidingState(placement: EditorWindowPlacementState): EditorWindowHidingState {
  return { ...placement, minimized: false };
}

test('FR-MDE-002 the visibility predicate runs with no DOM in scope', () => {
  assert.equal(typeof (globalThis as { document?: unknown }).document, 'undefined');
  assert.equal(typeof (globalThis as { window?: unknown }).window, 'undefined');

  // Every export is exercised here, so the claim covers the module rather than
  // whichever functions the cases below happen to reach.
  isEditorWindowVisible(visibleInput());
  restoreEditorWindow(minimizeEditorWindow(hidingState(createEditorWindowPlacementState())));
});

test('FR-MDE-002 each of the three visibility terms alone hides the window', () => {
  assert.equal(isEditorWindowVisible(visibleInput()), true);

  // Term 1 -- the only term a window button controls.
  assert.equal(isEditorWindowVisible(visibleInput({ minimized: true })), false);

  // Term 2 -- the workspace screen is not on screen.
  assert.equal(isEditorWindowVisible(visibleInput({ screen: 'settings' })), false);

  // Term 3 -- the window belongs to a workspace that is not the current one. This is
  // the workspace half of the judgement AppContent already makes for a tab wrapper.
  assert.equal(isEditorWindowVisible(visibleInput({ windowWorkspaceId: 'ws-other' })), false);
  assert.equal(isEditorWindowVisible(visibleInput({ activeWorkspaceId: null })), false);

  // And nothing else decides. The terminal tab the window was opened from, the
  // view mode of the workspace and the terminal area a `docked` window used to
  // cover are all gone from the input, which the source-text case at the bottom of
  // this file pins -- a value cannot be asked which fields its own type no longer
  // has.

  // The other half of AC-4 -- that a hidden window is still mounted -- needs a
  // mounted editor to observe and is judged by the Playwright suite. Nothing here
  // stands in for it: a boolean return value cannot distinguish hiding from
  // unmounting, so an assertion written against it would report coverage it does
  // not have.
});

test('FR-MDE-002 minimize and restore leave the placement state untouched', () => {
  // A window is created into `stage`, so the two placements are reached from
  // there: `floating` by a drag, and `stage` again by maximizing out of that
  // floating state. Listing the created state as well would repeat `stage`.
  const stage = createEditorWindowPlacementState();
  const floating = enterFloating(stage, { x: 320, y: 152, width: 640, height: 452 });
  const maximizedFromFloating = toggleMaximize(floating);

  [stage, floating, maximizedFromFloating].forEach((placement) => {
    const before = hidingState(placement);
    const minimized = minimizeEditorWindow(before);
    const restored = restoreEditorWindow(minimized);

    assert.equal(minimized.minimized, true);
    assert.equal(restored.minimized, false);

    // The placement axis is compared as a whole rather than field by field, so a
    // field added to the placement state later is covered without editing this.
    const placementOf = (state: EditorWindowHidingState): EditorWindowPlacementState => ({
      placement: state.placement,
      placementBeforeStage: state.placementBeforeStage,
      floatingRect: state.floatingRect,
    });
    assert.deepEqual(placementOf(minimized), placement);
    assert.deepEqual(placementOf(restored), placement);

    // Neither transition writes through to its input, so a window minimized while a
    // placement transition is in flight cannot lose the placement it came from.
    assert.equal(before.minimized, false);
  });
});

test('FR-MDE-002 clearing minimized alone does not make the window visible', () => {
  // Only term 1 is under the user's control. Restoring a window whose workspace is
  // not the current one leaves it hidden, and the button that calls restore must not
  // be written as though it decided visibility.
  const restored = restoreEditorWindow(
    minimizeEditorWindow(hidingState(createEditorWindowPlacementState())),
  );

  assert.equal(restored.minimized, false);
  assert.equal(
    isEditorWindowVisible(
      visibleInput({ minimized: restored.minimized, windowWorkspaceId: 'ws-other' }),
    ),
    false,
  );

  // The same window becomes visible once the term it was actually failing turns
  // true, which is what makes the case above a statement about term 3 rather than a
  // predicate that is false for everything.
  assert.equal(isEditorWindowVisible(visibleInput({ minimized: restored.minimized })), true);
});

test('CON-MDE-002 a window outlives the terminal tab it was opened from', () => {
  // The window used to be scoped to one terminal tab, and closing that tab took the
  // window -- and whatever the user had typed into it -- off the screen with it. The
  // window is bound to the workspace now, so neither switching away from that tab nor
  // closing it decides anything.
  // There is no field left to say which tab the window came from, so the window
  // survives that tab by construction. What is checkable here is that the terms
  // which did survive still decide.
  assert.equal(isEditorWindowVisible(visibleInput()), true);
  assert.equal(isEditorWindowVisible(visibleInput({ windowWorkspaceId: 'ws-other' })), false);
  assert.equal(isEditorWindowVisible(visibleInput({ minimized: true })), false);
  assert.equal(isEditorWindowVisible(visibleInput({ screen: 'settings' })), false);
});

// The input shape is a source-text fact: a value cannot be asked which fields its
// own type has stopped carrying. Reading the module text is what makes the removal
// of the terminal axis checkable at all.
const VISIBILITY_SOURCE = readFileSync(
  new URL('../../src/components/editor/editorWindowVisibility.ts', import.meta.url),
  'utf8',
);

test('FR-MDE-002 the visibility input carries the three terms and nothing else', () => {
  // The interface body is located before anything is asserted about its contents.
  // Without this a renamed interface would leave the match empty, and a negative
  // assertion over an empty string passes for free.
  const declared = /export interface EditorWindowVisibilityInput \{([\s\S]*?)\n\}/
    .exec(VISIBILITY_SOURCE);
  assert.notEqual(declared, null, 'the visibility input is still declared here');

  const fields = Array.from(
    (declared as RegExpExecArray)[1].matchAll(/^\s{2}(\w+)\??:/gm),
    (match) => match[1],
  );
  assert.deepEqual(
    fields.sort(),
    ['activeWorkspaceId', 'minimized', 'screen', 'windowWorkspaceId'],
  );

  // And the helper that answered the removed term is gone with it. Left behind it
  // would be an export nothing calls, and the next reader would take it for a term
  // the predicate still consults.
  assert.doesNotMatch(VISIBILITY_SOURCE, /export function hasUsableTerminalArea/);
});

// The window layer itself cannot be exercised here -- it is a React component and
// this suite has no DOM. What is checkable without one is where it is mounted and
// what it does with the predicate's answer, both of which are source-text facts.
// That a hidden window keeps its editor instance is a runtime observation and is
// judged by the Playwright suite; nothing below stands in for it.
const APP_SOURCE = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
const LAYER_SOURCE = readFileSync(
  new URL('../../src/components/editor/EditorWindowLayer.tsx', import.meta.url),
  'utf8',
);

test('FR-MDE-002 the window layer is mounted inside the provider and outside the stage', () => {
  // The opening tag is matched without its closing bracket, so adding a prop to the
  // provider does not read as the provider having moved.
  const providerOpen = APP_SOURCE.indexOf('<TerminalRuntimeProvider');
  const stageClose = APP_SOURCE.indexOf('</TerminalWorkspaceStage>');
  const layerMount = APP_SOURCE.indexOf('<EditorWindowLayer');
  const providerClose = APP_SOURCE.indexOf('</TerminalRuntimeProvider>');

  // Each anchor is checked for existence before the ordering is compared. Without
  // this, a renamed provider or a deleted layer would make every index -1 and the
  // ordering below would hold on absent things.
  [providerOpen, stageClose, layerMount, providerClose].forEach((index) => {
    assert.notEqual(index, -1);
  });

  assert.ok(providerOpen < layerMount, 'the layer is mounted after the provider opens');
  assert.ok(layerMount < providerClose, 'the layer is mounted before the provider closes');

  // And after the stage closes rather than inside its children callback. That callback
  // is swapped for the empty state when a workspace has no tabs, which would destroy
  // every window and its unsaved body on the way.
  assert.ok(stageClose < layerMount, 'the layer is not inside the stage children');

  // The mount is unconditional. A guard in front of it would be an unmount path that
  // the ordering above cannot see.
  const beforeMount = APP_SOURCE.slice(0, layerMount).trimEnd();
  assert.doesNotMatch(beforeMount, /(&&|\?|:)$/);

  // The registry the layer reads is that provider's context value, so a layer outside
  // it would throw rather than answer term 5 wrongly.
  assert.match(LAYER_SOURCE, /useTerminalRuntimeContext\(\)/);
});

test('FR-MDE-002 the layer is fed the real window list and a renderer that draws one', () => {
  // Where the mount is, the previous test pins. What it is fed, nothing did:
  // `windows` back to an empty literal, or `renderWindow` back to a function
  // answering null, leaves the whole suite green and no window ever reaches the
  // screen. Both are the single path by which a window becomes visible.
  const mountStart = APP_SOURCE.indexOf('<EditorWindowLayer');
  assert.notEqual(mountStart, -1, 'App.tsx still renders the layer');

  const mountEnd = APP_SOURCE.indexOf('/>', mountStart);
  assert.notEqual(mountEnd, -1, "App.tsx's layer element is self-closing");

  const mount = APP_SOURCE.slice(mountStart, mountEnd);

  // The list comes from the hook that holds it, not from a literal.
  assert.match(mount, /windows=\{[A-Za-z_$][\w$]*\.windows\}/);
  assert.doesNotMatch(mount, /windows=\{\s*\[\s*\]\s*\}/);

  // And the renderer builds a window rather than answering with nothing.
  const rendererStart = mount.indexOf('renderWindow=');
  assert.notEqual(rendererStart, -1, 'the layer is given a renderer');
  const renderer = mount.slice(rendererStart);
  assert.ok(renderer.includes('<EditorWindow'), 'the renderer mounts an editor window');
  assert.doesNotMatch(renderer, /renderWindow=\{\s*\(\s*\)\s*=>\s*null\s*\}/);
});

test('FR-MDE-002 the layer hands hiding to the window instead of dropping it', () => {
  // The predicate's answer reaches the surface as a value. It cannot be applied around
  // the surface: WindowDialog portals into document.body, so a style set by an
  // ancestor in the React tree lands on no DOM ancestor of the window.
  assert.match(LAYER_SOURCE, /hidden:\s*!\w+/);

  // renderWindow is called on every window in the list. Rather than enumerating the
  // shapes a guard could take, this reads the element the layer returns per window:
  // its only child is the call itself, so there is nowhere for a guard to sit. Every
  // conditional form -- `visible &&`, a ternary, an early return -- moves the call out
  // of that position.
  const fragmentOpen = LAYER_SOURCE.indexOf('<Fragment');
  const fragmentClose = LAYER_SOURCE.indexOf('</Fragment>');
  assert.notEqual(fragmentOpen, -1);
  assert.notEqual(fragmentClose, -1);

  const onlyChild = LAYER_SOURCE
    .slice(LAYER_SOURCE.indexOf('>', fragmentOpen) + 1, fragmentClose)
    .trim();
  assert.ok(onlyChild.startsWith('{renderWindow('), `unguarded call expected, got ${onlyChild}`);
  assert.ok(onlyChild.endsWith(')}'), `unguarded call expected, got ${onlyChild}`);

  // Windows are keyed by the file they hold, not by the tab they are bound to -- one
  // tab legitimately has several windows open over it.
  assert.match(LAYER_SOURCE, /key=\{\w+\.filePath\}/);
});
